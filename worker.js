// CORS用の共通レスポンスヘッダー（フロントエンドからの通信を許可）
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 指数的バックオフ付きのフェッチ関数
// ※Cloudflare Workersの実行時間制限（通常30秒）を考慮し、リトライを軽量化
async function fetchWithRetry(url, options, retries = 2) {
  const delays = [1000, 2000]; // 最大2回のリトライ
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (i === retries) return response; 
    } catch (e) {
      if (i === retries) throw e;
    }
    // スリープ処理
    if (i < retries) {
      await new Promise(resolve => setTimeout(resolve, delays[i]));
    }
  }
}

export default {
  async fetch(request, env) {
    // プリフライトリクエストの処理
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // エンドポイント 1: モンスター生成
      if (path === '/api/monster/generate' && request.method === 'POST') {
        return await handleGenerateMonster(request, env);
      }

      // エンドポイント 2: モンスターデータ単体取得
      const getMatch = path.match(/^\/api\/monster\/([a-f0-9]{64})$/);
      if (getMatch && request.method === 'GET') {
        return await handleGetMonster(getMatch[1], env);
      }

      // 存在しないエンドポイント
      return createJsonResponse({ error: 'Not Found' }, 404);

    } catch (err) {
      console.error("Worker Error:", err);
      return createJsonResponse({ error: 'Internal Server Error', message: err.message }, 500);
    }
  }
};

/**
 * モンスター生成ロジック
 */
async function handleGenerateMonster(request, env) {
  const body = await request.json();
  const { monsterName, birthday, ownerName } = body;

  if (!monsterName || !birthday) {
    return createJsonResponse({ error: 'モンスター名と生年月日は必須です。' }, 400);
  }

  const cleanName = monsterName.trim();
  const cleanBirthday = birthday.trim();
  const cleanOwner = (ownerName && ownerName.trim()) || 'ななしのブリーダー';

  // キャッシュの確認
  const cacheKey = `cache:${cleanName}_${cleanBirthday}`;
  const cachedId = await env.AIMON_STORE.get(cacheKey);
  
  if (cachedId) {
    const cachedDataStr = await env.AIMON_STORE.get(cachedId);
    if (cachedDataStr) {
      const cachedMonster = JSON.parse(cachedDataStr);
      if (ownerName && cachedMonster.ownerName !== cleanOwner) {
        cachedMonster.ownerName = cleanOwner;
        await env.AIMON_STORE.put(cachedId, JSON.stringify(cachedMonster));
      }
      return createJsonResponse({ success: true, isCached: true, data: cachedMonster });
    }
  }

  // 1. ハッシュでステータスを決定
  const traits = await calculateDeterministicTraits(cleanName, cleanBirthday);

  // 2. テキスト設定と画像用プロンプトの生成
  const aiText = await generateTextData(env, cleanName, traits);

  // 3. 画像の生成 (なのばなな: Gemini 2.5 Flash Image Preview)
  const base64Image = await generateImageWithNanoBanana(env, aiText.imagePrompt);

  // 4. Cloudinary への保存 (失敗時は生成されたBase64 Data URLを直接使用)
  let finalImageUrl = "";
  if (base64Image) {
    const dataUrl = `data:image/png;base64,${base64Image}`;
    finalImageUrl = await uploadToCloudinary(env, dataUrl, traits.id) || dataUrl;
  } else {
    // 画像生成に失敗した場合のデフォルトフォールバック
    finalImageUrl = `https://placehold.co/1024x1024/222222/ffffff.png?text=${encodeURIComponent(cleanName)}`;
  }

  // 5. 全データを統合して保存
  const fullMonsterData = {
    id: traits.id,
    monsterName: cleanName,
    birthday: cleanBirthday,
    ownerName: cleanOwner,
    clan: traits.clan,
    attribute: traits.attribute,
    species: traits.species,
    habitat: traits.habitat,
    rarity: traits.rarity,
    stats: traits.stats,
    specialName: aiText.specialName,
    specialDesc: aiText.specialDesc,
    flavorText: aiText.flavorText,
    imageUrl: finalImageUrl,
    createdAt: new Date().toISOString()
  };

  // KVストレージに保存
  // 処理時間のタイムアウトを防ぐため `await Promise.all` で並列保存
  await Promise.all([
    env.AIMON_STORE.put(traits.id, JSON.stringify(fullMonsterData)),
    env.AIMON_STORE.put(cacheKey, traits.id)
  ]);

  return createJsonResponse({ success: true, isCached: false, data: fullMonsterData });
}

/**
 * モンスターデータ取得ロジック
 */
async function handleGetMonster(id, env) {
  const monsterDataStr = await env.AIMON_STORE.get(id);
  if (!monsterDataStr) {
    return createJsonResponse({ error: '指定されたアイモンが見つかりません。' }, 404);
  }
  return createJsonResponse({ success: true, data: JSON.parse(monsterDataStr) });
}

/**
 * Gemini API でテキスト設定とプロンプトを生成
 */
async function generateTextData(env, monsterName, traits) {
  const defaultData = {
    specialName: `💥 必殺技：エレメントバースト`,
    specialDesc: `${traits.habitat}のエネルギーを放つ必殺技。`,
    flavorText: `${traits.habitat}に生息する${traits.species}。`,
    imagePrompt: `A highly detailed digital art of a cool monster named ${monsterName}, species ${traits.species}, element ${traits.attribute}, habitat ${traits.habitat}, trading card game style, dark background, dramatic lighting`
  };

  if (!env.GEMINI_API_KEY) return defaultData;

  // 本番環境用のモデル指定 (安定稼働のために gemini-2.5-flash または gemini-1.5-flash を利用)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const prompt = `ゲームのモンスター「${monsterName}」（種族: ${traits.species}, 属性: ${traits.attribute}, 生息地: ${traits.habitat}）の設定を考えてください。
また、その設定に完璧に合う、画像生成AI用のカッコいい英語のプロンプト（見た目の特徴、ポーズ、背景など）も詳しく1文で考えてください。
必ず以下のJSONフォーマットだけで返してください。
{
  "specialName": "絵文字1文字＋必殺技名",
  "specialDesc": "必殺技説明",
  "flavorText": "短い世界観テキスト1文",
  "imagePrompt": "Detailed English image prompt for this monster, trading card game style, dark background"
}`;

  try {
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });

    if (response.ok) {
      const result = await response.json();
      const rawText = result.candidates[0]?.content?.parts[0]?.text;
      if (rawText) {
        const parsed = JSON.parse(rawText.trim());
        return { ...defaultData, ...parsed }; // 生成結果で上書き
      }
    } else {
      console.error("Text generation API error status:", response.status);
    }
  } catch (e) {
    console.error("Text generation failed:", e);
  }
  return defaultData;
}

/**
 * なのばなな (Gemini 2.5 Flash Image Preview) を使った画像生成
 */
async function generateImageWithNanoBanana(env, imagePrompt) {
  if (!env.GEMINI_API_KEY) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=${env.GEMINI_API_KEY}`;
  
  try {
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: imagePrompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE"]
        }
      })
    });

    if (response.ok) {
      const result = await response.json();
      const parts = result.candidates[0]?.content?.parts;
      const imagePart = parts?.find(p => p.inlineData);
      
      if (imagePart && imagePart.inlineData) {
        return imagePart.inlineData.data; // Base64文字列を返す
      }
    } else {
      const errText = await response.text();
      console.error("Image generation API error:", response.status, errText);
    }
  } catch (e) {
    console.error("Nano Banana Image generation failed:", e);
  }
  return null;
}

/**
 * Cloudinary への画像アップロード
 */
async function uploadToCloudinary(env, fileDataUrl, publicId) {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_UPLOAD_PRESET) return null;

  const url = `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`;
  const formData = new FormData();
  formData.append('file', fileDataUrl);
  formData.append('upload_preset', env.CLOUDINARY_UPLOAD_PRESET);
  formData.append('public_id', `aimon_${publicId}`);

  try {
    const response = await fetchWithRetry(url, {
      method: 'POST',
      body: formData
    });

    if (response.ok) {
      const result = await response.json();
      return result.secure_url;
    } else {
      console.error("Cloudinary upload error:", response.status);
    }
  } catch (e) {
    console.error("Cloudinary upload failed:", e);
  }
  return null;
}

/**
 * 決定的な特性算出ロジック
 */
async function calculateDeterministicTraits(name, birthday) {
  const seed = `${name}_${birthday}`;
  const msgBuffer = new TextEncoder().encode(seed);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const p1 = parseInt(hash.substring(0, 8), 16);
  const p2 = parseInt(hash.substring(8, 16), 16);
  const p3 = parseInt(hash.substring(16, 24), 16);
  const p4 = parseInt(hash.substring(24, 32), 16);
  const p5 = parseInt(hash.substring(32, 40), 16);

  const clans = ['炎クラン', '水クラン', '風クラン', '地クラン', '光クラン', '闇クラン'];
  const attributes = ['炎属性', '水属性', '風属性', '地属性', '光属性', '闇属性'];
  const speciesList = ['ドラゴン族', '獣人族', '精霊族', '不死族', '幻獣族', '機械族'];
  const habitats = ['火山地帯', '深海・水辺', '天空・平原', '地下洞窟', '古の神殿', '忘れられた廃墟'];

  const rarityRoll = p5 % 100;
  let rarity = '★';
  if (rarityRoll < 5) rarity = '★★★★★';
  else if (rarityRoll < 20) rarity = '★★★★';
  else if (rarityRoll < 60) rarity = '★★★';
  else if (rarityRoll < 90) rarity = '★★';

  return {
    id: hash,
    clan: clans[p1 % clans.length],
    attribute: attributes[p2 % attributes.length],
    species: speciesList[p3 % speciesList.length],
    habitat: habitats[p4 % habitats.length],
    rarity: rarity,
    stats: {
      hp: (p1 % 100) + 1,
      atk: (p2 % 100) + 1,
      def: (p3 % 100) + 1,
      spd: (p4 % 100) + 1,
      mgc: (p5 % 100) + 1,
      lck: (p5 % 50) + 1
    }
  };
}

/**
 * JSONレスポンス生成ヘルパー
 */
function createJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
