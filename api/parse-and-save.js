import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

let isConnected = false;
async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI);
  isConnected = true;
}

const merchantSchema = new mongoose.Schema({
  name: String,
  email: String,
  apiKey: String,
  status: { type: String, default: 'active' },
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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `
You are an expert Egyptian E-commerce Logistics Assistant specialized in extracting shipping info from Egyptian Arabic text.
Analyze the text and extract details into a raw JSON object matching this exact schema (no markdown, no backticks):
{
  "customerName": "الاسم الكامل أو null",
  "phone": "رقم الموبايل الأساسي 11 رقم يبدأ بـ 01 أو null",
  "secondary_phone": "رقم الموبايل الثاني أو null",
  "governorate": "المحافظة المصرية أو null",
  "city": "المركز أو المدينة أو الحي أو null",
  "address": "تفاصيل القرية والشارع ورقم البيت أو null",
  "landmark": "علامة مميزة أو null",
  "items": "المنتجات المطلوبة والكميات أو null",
  "notes": "ملاحظات إضافية أو null"
}
Convert Eastern Arabic numerals to Western.
`;

const CANDIDATE_MODELS = ['gemini-2.5-flash', 'gemini-1.5-flash'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    await connectToDatabase();
    const { text, apiKey } = req.body;

    if (!text || !apiKey) {
      return res.status(400).json({ success: false, error: 'النص ومفتاح الـ API مطلوبان' });
    }

    const merchant = await Merchant.findOne({ apiKey });
    if (!merchant || merchant.status !== 'active') {
      return res.status(403).json({ success: false, error: 'مفتاح غير صحيح أو حساب موقوف' });
    }
    if (merchant.ordersUsed >= merchant.orderLimit) {
      return res.status(403).json({ success: false, error: 'لقد استنفدت حد الطلبات المسموح به' });
    }

    let parsedData = null;
    let lastError = null;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model: `models/${modelName}`,
          contents: `${SYSTEM_PROMPT}\n\nText to parse:\n${text}`,
        });
        
        let rawText = response.text.trim();
        // تنظيف النتيجة لو فيها أي كود ماركداون بالخطأ
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        parsedData = JSON.parse(rawText);
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!parsedData) {
      throw new Error(`فشل الذكاء الاصطناعي في تحليل النص: ${lastError?.message}`);
    }

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
}