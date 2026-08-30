import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. تهيئة Google GenAI SDK (Gemini Flash)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 2. الـ System Prompt لمعالجة استخراج البيانات بالعامية المصرية
const SYSTEM_PROMPT = `
You are an expert Egyptian E-commerce Logistics Assistant specialized in extracting shipping info from Egyptian Arabic text.
Return ONLY a raw JSON object matching this schema (no markdown, no backticks):
{
  "name": string or null,
  "phone": 11-digit string starting with 01 or null,
  "secondary_phone": string or null,
  "governorate": official Egyptian governorate in Arabic or null,
  "city": area/city in Arabic or null,
  "street_address": street/building/floor details or null,
  "landmark": nearby landmark or null,
  "notes": special delivery instructions or order details or null
}
Convert Eastern Arabic numerals (٠١٢٣٤٥٦٧٨٩) to Western (0123456789).
`;

// 3. دالة إرسال البيانات إلى Google Apps Script
async function saveToGoogleSheet(data) {
  const appsScriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;

  if (!appsScriptUrl) {
    throw new Error('GOOGLE_APPS_SCRIPT_URL is not set in .env file');
  }

  // إرسال البيانات كطلب HTTP POST إلى رابط الـ Web App
  const response = await fetch(appsScriptUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  const result = await response.json();

  if (result.result !== 'success') {
    throw new Error(result.error || 'Failed to save order to Google Sheet via Apps Script');
  }

  return result;
}

// 4. الـ Endpoint الرئيسي لاستقبال الطلبات من الـ Extension
app.post('/api/parse-and-save', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ success: false, error: 'Text field is required' });
    }

    const aiResponse = await ai.models.generateContent({
      model: 'gemini-3.6-flash', // 👈 الموديل المعتمد حالياً
      contents: text,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const parsedData = JSON.parse(aiResponse.text);
    await saveToGoogleSheet(parsedData);

    return res.json({
      success: true,
      message: 'Data processed and saved successfully',
      data: parsedData,
    });
  } catch (error) {
    console.error('Server Processing Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to process request',
      details: error.message,
    });
  }
});

// 5. تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend server is running on http://localhost:${PORT}`);
});