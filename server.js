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
You are an expert Egyptian E-commerce Logistics Assistant specialized in extracting shipping info from Egyptian Arabic text.
Return ONLY a raw JSON object matching this schema (no markdown, no backticks):
{
  "customerName": string or null,
  "phone": 11-digit string starting with 01 or null,
  "governorate": official Egyptian governorate in Arabic or null,
  "address": street/building/floor/city details in Arabic or null,
  "items": order items details or null
}
Convert Eastern Arabic numerals (٠١٢٣٤٥٦٧٨٩) to Western (0123456789).
`;

// 4. دالة حفظ البيانات في Google Sheet الخاص بالتاجر
async function saveToGoogleSheet(appsScriptUrl, data) {
  const response = await fetch(appsScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const result = await response.json();
  if (result.status !== 'success' && result.result !== 'success') {
    throw new Error(result.error || result.message || 'فشل حفظ الطلب في Google Sheet');
  }
  return result;
}

// 5. الـ Endpoint الرئيسي لاستقبال الطلبات من إضافة الكروم
app.post('/api/parse-and-save', async (req, res) => {
  try {
    // الاتصال بقاعدة البيانات أولاً وضمان الجاهزية
    await connectToDatabase();

    const { text, apiKey } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: 'النص مطلوب' });
    }
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'مفتاح الـ API Key مطلوب' });
    }

    // التحقق من التاجر في قاعدة البيانات
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

    // تحليل النص باستخدام Gemini (الموديل المستقر)
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: text,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const parsedData = JSON.parse(aiResponse.text);

    // إرسال البيانات لشيت جوجل الخاص بالتاجر
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

// 1. إنشاء تاجر جديد
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

// 2. عرض جميع التجار ومتابعة استهلاكهم
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

// 3. تعديل حالة التاجر (تفعيل / إيقاف / تجديد رصيد)
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

// ==========================================
// عرض لوحة الأدمن (Static Files)
// ==========================================
app.use(express.static(__dirname));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'admin.html'));
});

// تشغيل المحلي والتصدير لـ Vercel
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

export default app;