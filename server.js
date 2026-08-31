import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// 1. دالة الاتصال المحسّنة لبيئات Serverless (MongoDB Atlas)
let isConnected = false;

async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }
  if (process.env.MONGODB_URI) {
    const db = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = db.connections[0].readyState === 1;
    console.log('✅ Connected to MongoDB Atlas');
  } else {
    throw new Error('MONGODB_URI غير معرّف في متغيرات البيئة!');
  }
}

// 2. تعريف موديل التاجر (Merchant Model)
const merchantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  apiKey: { type: String, required: true, unique: true },
  googleSheetUrl: { type: String, required: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  orderLimit: { type: Number, default: 100 },
  ordersUsed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const Merchant = mongoose.models.Merchant || mongoose.model('Merchant', merchantSchema);

// 3. تهيئة Google GenAI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `
You are an expert Egyptian E-commerce Logistics Assistant specialized in extracting shipping info from Egyptian Arabic text (including Upper Egypt / Sa'eed addresses).
Analyze the text and extract details into a raw JSON object matching this exact schema (no markdown, no backticks):
{
  "customerName": "الاسم الكامل المذكور في النص أو null",
  "phone": "رقم الموبايل الأساسي المكون من 11 رقم يبدأ بـ 01 أو null",
  "secondary_phone": "رقم الموبايل الثاني لو موجود أو null",
  "governorate": "المحافظة المصرية الرسمية (مثل قنا، الإسكندرية، القاهرة...) أو null",
  "city": "المركز أو المدينه أو الحي (مثل دشنا، العجمي...) أو null",
  "address": "تفاصيل القرية والنجع والشارع ورقم البيت أو null",
  "landmark": "أقرب علامة مميزة (مثل بجوار مجمع...) أو null",
  "items": "المنتجات المطلوبة والكميات (مثل اتنين تيشرت) أو null",
  "notes": "أي ملاحظات إضافية أو وقت التوصيل أو null"
}
Convert Eastern Arabic numerals (٠١٢٣٤٥٦٧٨٩) to Western (0123456789). Extract accurately even if text is written in natural conversational Egyptian dialect.
`;

// 4. دالة الاستدعاء الذكي مع تجربة عدة موديلات تلقائياً (Fallback Mechanism)
const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL, // للتحكم الخارجي من Vercel لو لزم الأمر
  'gemini-3.6-flash',       // الموديل الأساسي الأحدث
  'gemini-2.5-flash',       // بديل أول
  'gemini-2.0-flash',       // بديل ثاني
  'gemini-1.5-flash'        // بديل مستقر نهائي
].filter(Boolean);

async function parseTextWithFallback(text) {
  let lastError;

  for (const modelName of CANDIDATE_MODELS) {
    try {
      console.log(`Trying Gemini model: ${modelName}...`);
      const response = await ai.models.generateContent({
        model: modelName,
        contents: text,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });
      return response; // نجح الموديل، يرجع بالنتيجة فوراً
    } catch (err) {
      console.warn(`Model ${modelName} failed: ${err.message}. Trying next...`);
      lastError = err;
    }
  }

  throw new Error(`فشلت جميع موديلات Gemini المتاحة: ${lastError?.message}`);
}

// 5. دالة حفظ البيانات في Google Sheet الخاص بالتاجر
async function saveToGoogleSheet(appsScriptUrl, data) {
  const response = await fetch(appsScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const rawText = await response.text();
  let result;
  
  try {
    result = JSON.parse(rawText);
  } catch (err) {
    throw new Error('رابط Google Sheet الخاص بالتاجر غير صحيح أو غير منشور كـ Public (Anyone)');
  }

  if (result.status !== 'success' && result.result !== 'success') {
    throw new Error(result.error || result.message || 'فشل حفظ الطلب في Google Sheet');
  }
  return result;
}

// 6. الـ Endpoint الرئيسي لاستقبال الطلبات من إضافة الكروم
app.post('/api/parse-and-save', async (req, res) => {
  try {
    await connectToDatabase();

    const { text, apiKey } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: 'النص مطلوب' });
    }
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'مفتاح الـ API Key مطلوب' });
    }

    const merchant = await Merchant.findOne({ apiKey });

    if (!merchant) {
      return res.status(403).json({ success: false, error: 'مفتاح الـ API Key غير صحيح' });
    }

    if (merchant.status !== 'active') {
      return res.status(403).json({ success: false, error: 'حساب التاجر موقوف، يرجى التواصل مع الدعم' });
    }

    if (merchant.ordersUsed >= merchant.orderLimit) {
      return res.status(403).json({ success: false, error: 'لقد استنفدت حد الطلبات المسموح به في باقتك' });
    }

    // تحليل النص باستخدام آلية البدائل التلقائية للموديلات
    const aiResponse = await parseTextWithFallback(text);
    const parsedData = JSON.parse(aiResponse.text);

    // إرسال البيانات لشيت جوجل
    await saveToGoogleSheet(merchant.googleSheetUrl, parsedData);

    // خصم طلب من رصيد التاجر
    merchant.ordersUsed += 1;
    await merchant.save();

    return res.json({
      success: true,
      message: 'تمت معالجة الطلب وخصمه بنجاح',
      ordersLeft: merchant.orderLimit - merchant.ordersUsed,
      data: parsedData,
    });
  } catch (error) {
    console.error('Server Processing Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'حدث خطأ أثناء معالجة الطلب',
      details: error.toString(),
    });
  }
});

// ==========================================
// مسارات لوحة تحكم الأدمن (Admin Routes)
// ==========================================
app.post('/api/admin/merchants', async (req, res) => {
  try {
    await connectToDatabase();
    const { adminKey, name, email, googleSheetUrl, orderLimit } = req.body;

    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(401).json({ success: false, error: 'غير مصرح لك بالدخول' });
    }

    const generatedApiKey = 'cto_live_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

    const newMerchant = new Merchant({
      name,
      email,
      apiKey: generatedApiKey,
      googleSheetUrl,
      orderLimit: Number(orderLimit) || 100
    });

    await newMerchant.save();
    res.json({ success: true, merchant: newMerchant });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/merchants', async (req, res) => {
  try {
    await connectToDatabase();
    const { adminKey } = req.query;

    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(401).json({ success: false, error: 'غير مصرح لك' });
    }

    const merchants = await Merchant.find().sort({ createdAt: -1 });
    res.json({ success: true, merchants });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/admin/merchants/:id', async (req, res) => {
  try {
    await connectToDatabase();
    const { adminKey, status, orderLimit } = req.body;

    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(401).json({ success: false, error: 'غير مصرح لك' });
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (orderLimit !== undefined) updateData.orderLimit = Number(orderLimit);

    const updatedMerchant = await Merchant.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    res.json({ success: true, merchant: updatedMerchant });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use(express.static(__dirname));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'admin.html'));
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

export default app;