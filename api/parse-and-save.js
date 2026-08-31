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

const merchantSchema = new mongoose.Schema({ name: String, apiKey: String, status: String, orderLimit: Number, ordersUsed: Number });
const orderSchema = new mongoose.Schema({ merchantId: mongoose.Schema.Types.ObjectId, customerName: String, phone: String, secondary_phone: String, governorate: String, city: String, address: String, landmark: String, items: String, notes: String, createdAt: { type: Date, default: Date.now } });
const Merchant = mongoose.models.Merchant || mongoose.model('Merchant', merchantSchema);
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const SYSTEM_PROMPT = `Extract shipping info into exact JSON: {"customerName":..., "phone":..., "secondary_phone":..., "governorate":..., "city":..., "address":..., "landmark":..., "items":..., "notes":...}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await connectToDatabase();
    const { text, apiKey } = req.body;
    if (!text || !apiKey) return res.status(400).json({ success: false, error: 'النص ومفتاح الـ API مطلوبان' });

    const merchant = await Merchant.findOne({ apiKey });
    if (!merchant || merchant.status !== 'active') return res.status(403).json({ success: false, error: 'مفتاح غير صحيح' });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: text,
      config: { systemInstruction: SYSTEM_PROMPT, responseMimeType: 'application/json' },
    });

    const parsedData = JSON.parse(response.text);
    const newOrder = new Order({ merchantId: merchant._id, ...parsedData });
    await newOrder.save();

    return res.json({ success: true, message: 'تم الحفظ', data: parsedData });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}