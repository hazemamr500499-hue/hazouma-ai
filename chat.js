/**
 * Hazouma AI — Backend Serverless Function (Vercel Edge Function)
 * =================================================================
 * المسار: /api/chat
 * الوظيفة: بيستقبل رسائل المستخدم من الـ Frontend، يبعتها لـ Gemini API
 * باستخدام مفتاح سري مخزّن في متغيرات بيئة السيرفر (Environment Variables)،
 * وبيرجّع الرد كـ stream مباشرة للـ Frontend.
 *
 * ⚠️ المفتاح مش موجود في الكود ده خالص. لازم تحطه في:
 *    Vercel Dashboard → Project → Settings → Environment Variables
 *    Name:  GEMINI_API_KEY
 *    Value: مفتاحك الحقيقي من https://aistudio.google.com/apikey
 *           (لازم يبدأ بـ "AIza..." — ده الشكل الرسمي لمفاتيح Gemini API)
 *
 * ملحوظة: النص اللي شكله "AQ.xxxxx" مش صيغة مفتاح Gemini API، فلو معاك
 * حاجة شكلها كده متحطهاش هنا — هي على الأغلب توكن من نظام تاني خالص.
 * =================================================================
 */

// Edge Runtime: أسرع، بيدعم الـ streaming بشكل مباشر (pipe) من Gemini للمستخدم
// من غير ما السيرفر يحمّل الرد كامل في الذاكرة الأول.
export const config = {
  runtime: "edge",
};

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const DEFAULT_MODEL = "gemini-flash-latest"; // اسم مستعار بيشاور دايمًا على أحدث نسخة GA من Gemini Flash

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status: status || 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async function handler(req) {
  // --- CORS بسيط (سيب الموقع بتاعك بس هو اللي يكلم الـ API ده لو حابب تقيّده لاحقًا) ---
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonError("Method not allowed. استخدم POST.", 405);
  }

  // --- المفتاح بييجي من متغير البيئة بس، مش من أي مكان تاني ---
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[api/chat] GEMINI_API_KEY غير موجود في Environment Variables على Vercel.");
    return jsonError(
      "السيرفر مش مظبوط لسه: متغير البيئة GEMINI_API_KEY مش موجود. راجع Vercel → Settings → Environment Variables.",
      500
    );
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return jsonError("جسم الطلب (body) لازم يكون JSON صحيح.", 400);
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemInstructionText =
    typeof payload.systemInstruction === "string" ? payload.systemInstruction : "";

  if (!messages.length) {
    return jsonError("محتاج تبعت رسالة واحدة على الأقل في messages.", 400);
  }

  // اختياري: تقدر تظبط الموديل من متغير بيئة كمان (GEMINI_MODEL) من غير ما تلمس الكود
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  const geminiBody = {
    contents: messages,
  };
  if (systemInstructionText) {
    geminiBody.systemInstruction = { parts: [{ text: systemInstructionText }] };
  }

  const url =
    GEMINI_API_BASE +
    encodeURIComponent(model) +
    ":streamGenerateContent?alt=sse&key=" +
    encodeURIComponent(apiKey);

  let geminiRes;
  try {
    geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });
  } catch (e) {
    console.error("[api/chat] فشل الاتصال بـ Gemini:", e);
    return jsonError("تعذّر الاتصال بخوادم Gemini. حاول تاني.", 502);
  }

  if (!geminiRes.ok || !geminiRes.body) {
    let errText = "";
    try {
      errText = await geminiRes.text();
    } catch (e) {}
    console.error("[api/chat] Gemini رجّع خطأ:", geminiRes.status, errText);

    // رسائل واضحة للأخطاء الشائعة عشان تقدر تشخّص بسرعة من لوجات Vercel
    let friendly = errText || ("HTTP " + geminiRes.status);
    if (geminiRes.status === 400) friendly = "طلب غير صالح أو مفتاح API غير صحيح. (" + errText + ")";
    else if (geminiRes.status === 403) friendly = "المفتاح مرفوض (403). تأكد إن Gemini API مفعّل على نفس المشروع بتاع المفتاح. (" + errText + ")";
    else if (geminiRes.status === 429) friendly = "تعدّيت الحد المسموح من الطلبات (429) على المفتاح ده حاليًا. (" + errText + ")";

    return jsonError(friendly, geminiRes.status);
  }

  // تمرير الـ stream زي ما هو مباشرة للـ Frontend (بصيغة SSE: "data: {...}\n\n")
  return new Response(geminiRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}