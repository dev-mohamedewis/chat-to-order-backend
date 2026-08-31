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

// 1. الاتصال بقاعدة البيانات
let isConnected = false;
async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) return;
  if (process.env.MONGODB_URI) {
    const db = await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    isConnected = db.connections[0].readyState === 1;
    console.log('✅ Connected to MongoDB Atlas');
  } else {
    throw new Error('MONGODB_URI غير معرّف في متغيرات البيئة!');
  }
}

// 2. الموديلات (Merchant & Order)
const merchantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  apiKey: { type: String, required: true, unique: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  orderLimit: { type: Number, default: 100 },
  ordersUsed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
  customerName: String,
  phone: String,
  secondary_phone: String,
  governorate: String,
  city: String,
  address: String,
  landmark: String,
  items: String,
  notes: String,
  status: { type: String, default: 'جديد' },
  createdAt: { type: Date, default: Date.now }
});

const Merchant = mongoose.models.Merchant || mongoose.model('Merchant', merchantSchema);
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

// 3. تهيئة الذكاء الاصطناعي مع البدائل
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `
You are an expert Egyptian E-commerce Logistics Assistant specialized in extracting shipping info from Egyptian Arabic text (including Upper Egypt / Sa'eed addresses).
Analyze the text and extract details into a raw JSON object matching this exact schema (no markdown, no backticks):
{
  "customerName": "الاسم الكامل المذكور في النص أو null",
  "phone": "رقم الموبايل الأساسي المكون من 11 رقم يبدأ بـ 01 أو null",
  "secondary_phone": "رقم الموبايل الثاني لو موجود أو null",
  "governorate": "المحافظة المصرية الرسمية أو null",
  "city": "المركز أو المدينه أو الحي أو null",
  "address": "تفاصيل القرية والنجع والشارع ورقم البيت أو null",
  "landmark": "أقرب علامة مميزة أو null",
  "items": "المنتجات المطلوبة والكميات أو null",
  "notes": "أي ملاحظات إضافية أو وقت التوصيل أو null"
}
Convert Eastern Arabic numerals (٠١٢٣٤٥٦٧٨٩) to Western (0123456789).
`;

const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-3.6-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
].filter(Boolean);

async function parseTextWithFallback(text) {
  let lastError;
  for (const modelName of CANDIDATE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: text,
        config: { systemInstruction: SYSTEM_PROMPT, responseMimeType: 'application/json', temperature: 0.1 },
      });
      return response;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`فشلت جميع موديلات Gemini: ${lastError?.message}`);
}

// 4. الـ Endpoint الرئيسي لاستقبال الطلبات من الإضافة
app.post('/api/parse-and-save', async (req, res) => {
  try {
    await connectToDatabase();
    const { text, apiKey } = req.body;

    if (!text || !apiKey) return res.status(400).json({ success: false, error: 'النص ومفتاح الـ API مطلوبان' });

    const merchant = await Merchant.findOne({ apiKey });
    if (!merchant || merchant.status !== 'active') {
      return res.status(403).json({ success: false, error: 'مفتاح غير صحيح أو حساب موقوف' });
    }
    if (merchant.ordersUsed >= merchant.orderLimit) {
      return res.status(403).json({ success: false, error: 'لقد استنفدت حد الطلبات المسموح به' });
    }

    const aiResponse = await parseTextWithFallback(text);
    const parsedData = JSON.parse(aiResponse.text);

    // حفظ الطلب في قاعدة البيانات مباشرة بدلاً من الشيت
    const newOrder = new Order({
      merchantId: merchant._id,
      ...parsedData
    });
    await newOrder.save();

    merchant.ordersUsed += 1;
    await merchant.save();

    return res.json({ success: true, message: 'تم حفظ الطلب بنجاح', data: parsedData });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 5. مسارات الداشبورد الخاصة بالتاجر
app.get('/api/merchant/orders', async (req, res) => {
  try {
    await connectToDatabase();
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (!apiKey) return res.status(401).json({ success: false, error: 'مفتاح الـ API مفقود' });

    const merchant = await Merchant.findOne({ apiKey });
    if (!merchant) return res.status(403).json({ success: false, error: 'تاجر غير موجود' });

    const orders = await Order.find({ merchantId: merchant._id }).sort({ createdAt: -1 });
    res.json({ success: true, merchantName: merchant.name, orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. مسارات الأدمن لإدارة التجار
app.post('/api/admin/merchants', async (req, res) => {
  try {
    await connectToDatabase();
    const { adminKey, name, email, orderLimit } = req.body;
    if (adminKey !== process.env.ADMIN_SECRET_KEY) return res.status(401).json({ success: false, error: 'غير مصرح' });

    const apiKey = 'cto_live_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    const newMerchant = new Merchant({ name, email, apiKey, orderLimit: Number(orderLimit) || 100 });
    await newMerchant.save();
    res.json({ success: true, merchant: newMerchant });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use(express.static(__dirname));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'merchant-dashboard.html'));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export default app;