const FALLBACK = {
  fluctuate: {
    word: "fluctuate",
    pos: "v.",
    zh: "波动；起伏不定",
    en: "to change frequently in size, amount, quality, or level",
    examples: [{ text: "Temperatures fluctuate widely in desert regions.", source: "学习语境：自然地理类杂志/纪录片常见表达" }],
    collocations: [
      { text: "prices fluctuate", source: "经济报道常见搭配" },
      { text: "fluctuate between", source: "说明文常见搭配" },
      { text: "fluctuate considerably", source: "数据描述常见搭配" }
    ]
  },
  empirical: {
    word: "empirical",
    pos: "adj.",
    zh: "经验主义的；基于实证的",
    en: "based on observation, experience, or experiment",
    examples: [{ text: "The author supports the argument with empirical evidence.", source: "学习语境：科研杂志/论文摘要常见表达" }],
    collocations: [
      { text: "empirical evidence", source: "学术文章高频搭配" },
      { text: "empirical research", source: "研究类文章常见搭配" },
      { text: "empirical data", source: "科研报道常见搭配" }
    ]
  },
  sustainable: {
    word: "sustainable",
    pos: "adj.",
    zh: "可持续的",
    en: "able to continue without damaging the environment or using too many resources",
    examples: [{ text: "The city invested in sustainable transport systems.", source: "学习语境：环保杂志/城市规划文章常见表达" }],
    collocations: [
      { text: "sustainable development", source: "环保与政策文章高频搭配" },
      { text: "sustainable agriculture", source: "农业环保文章常见搭配" },
      { text: "sustainable growth", source: "经济杂志常见搭配" }
    ]
  }
};

const POS_MAP = {
  noun: "n.",
  verb: "v.",
  adjective: "adj.",
  adverb: "adv.",
  pronoun: "pron.",
  preposition: "prep.",
  conjunction: "conj."
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lookup") return lookupRoute(url, env);
    if (url.pathname === "/api/health") return json({ ok: true });
    return html(INDEX_HTML);
  }
};

async function lookupRoute(url, env) {
  const word = clean(url.searchParams.get("word") || "");
  if (!word) return json({ error: "请输入英文单词" }, 400);
  try {
    const entry = await lookupWord(word, env);
    return json(entry);
  } catch (error) {
    const fallback = fallbackEntry(word);
    fallback.notice = "线上抓取暂时失败，已使用本地学习模板。";
    return json(fallback);
  }
}

async function lookupWord(word, env) {
  const [dict, corpus, phrases, magazine] = await Promise.allSettled([
    dictionaryApi(word),
    gutenbergExample(word),
    dictionaryPhrases(word),
    guardianExample(word, env)
  ]);
  const base = FALLBACK[word] || {};
  const dictionary = dict.status === "fulfilled" ? dict.value : {};
  const bookExample = corpus.status === "fulfilled" ? corpus.value : null;
  const magazineExample = magazine.status === "fulfilled" ? magazine.value : null;
  const dm = phrases.status === "fulfilled" ? phrases.value : [];
  const examples = [
    magazineExample,
    bookExample,
    ...(dictionary.examples || []),
    ...(base.examples || [])
  ].filter(Boolean).slice(0, 4);
  const collocations = [
    ...dm,
    ...(base.collocations || [])
  ].filter(Boolean).slice(0, 6);
  return {
    word,
    contentVersion: 2,
    pos: dictionary.pos || base.pos || guessPos(word),
    zh: dictionary.zh || base.zh || autoChinese(word, dictionary.pos || guessPos(word)),
    en: dictionary.en || base.en || autoEnglish(word, dictionary.pos || guessPos(word)),
    definitions: dictionary.definitions || buildFallbackDefinitions(word, base, dictionary.pos || guessPos(word)),
    examples,
    collocations,
    sources: {
      dictionary: dictionary.source || "Free Dictionary API / 本地规则",
      corpus: bookExample ? bookExample.source : "Project Gutenberg 未找到合适句子",
      collocations: dm.length ? "词典搭配" : "学习搭配",
      magazine: magazineExample ? magazineExample.source : "可选：配置 GUARDIAN_API_KEY 后抓取杂志/新闻语料"
    }
  };
}

async function dictionaryApi(word) {
  const chinese = await youdaoChinese(word).catch(() => null);
  if (chinese?.definitions?.length) return { ...chinese, en: chinese.definitions.map(d => d.en).join("; "), zh: chinese.definitions.map(d => d.zh).join("；"), source: "柯林斯英汉双解（有道词典）" };
  try {
    return await freeDictionaryApi(word, chinese);
  } catch {
    return await datamuseDefinitions(word, chinese);
  }
}

async function freeDictionaryApi(word, chinese) {
  const res = await fetchWithTimeout(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, 12000);
  if (!res.ok) throw new Error("dictionary lookup failed");
  const data = await res.json();
  const first = data?.[0];
  const definitions = [];
  const examples = [];
  for (const meaning of first?.meanings || []) {
    const pos = POS_MAP[meaning?.partOfSpeech] || meaning?.partOfSpeech || "";
    for (const def of meaning?.definitions || []) {
      if (!def?.definition) continue;
      definitions.push({
        pos,
        en: def.definition,
        zh: "",
        synonyms: [...(def.synonyms || []), ...(meaning.synonyms || [])].slice(0, 6)
      });
      if (def.example) examples.push({ text: def.example, source: "Free Dictionary API 例句" });
      if (definitions.length >= 8) break;
    }
    if (definitions.length >= 8) break;
  }
  const translated = await Promise.all(definitions.map(async item => ({
    ...item,
    zh: item.zh || await translateDefinition(item.en, word, item.pos)
  })));
  const firstDef = translated[0];
  return {
    pos: chinese?.pos || firstDef?.pos || "",
    en: translated.map((item, i) => `${i + 1}. [${item.pos || "词性待定"}] ${item.en}`).join("\n"),
    zh: chinese?.zh || translated.map((item, i) => `${i + 1}. [${item.pos || "词性待定"}] ${item.zh}`).join("\n"),
    definitions: translated,
    examples: uniqueByText(examples),
    source: chinese ? "有道词典 + Free Dictionary API" : "Free Dictionary API"
  };
}

async function datamuseDefinitions(word, chinese) {
  const res = await fetchWithTimeout(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=d&max=1`, 5000);
  if (!res.ok) throw new Error("datamuse definition lookup failed");
  const data = await res.json();
  const defs = data?.[0]?.defs || [];
  if (!defs.length) throw new Error("no definitions");
  const definitions = await Promise.all(defs.slice(0, 8).map(async raw => {
    const [tag, ...rest] = raw.split("\t");
    const en = rest.join("\t") || raw;
    const pos = datamusePos(tag);
    return { pos, en, zh: await translateDefinition(en, word, pos), synonyms: [] };
  }));
  return {
    pos: chinese?.pos || definitions[0]?.pos || guessPos(word),
    en: definitions.map((item, i) => `${i + 1}. [${item.pos || "词性待定"}] ${item.en}`).join("\n"),
    zh: chinese?.zh || definitions.map((item, i) => `${i + 1}. [${item.pos || "词性待定"}] ${item.zh}`).join("\n"),
    definitions,
    examples: [],
    source: chinese ? "有道词典 + Datamuse API definitions" : "Datamuse API definitions"
  };
}

async function youdaoChinese(word) {
  const data = await dictionaryData(word);
  const definitions = [];
  const examples = [];
  for (const group of data?.collins?.collins_entries || []) {
    if (group.headword && group.headword.toLowerCase() !== word) continue;
    for (const entry of group.entries?.entry || []) for (const tr of entry.tran_entry || []) {
      const text = stripTags(tr.tran || "").trim();
      let at = text.search(/[\u3400-\u9fff]/);
      if (at < 1) continue;
      while (at > 0 && /[(（\s]/.test(text[at - 1])) at--;
      const en = text.slice(0, at).trim(), zh = text.slice(at).trim();
      const tag = tr.pos_entry?.pos || "";
      const pos = tag.startsWith("N") ? "n." : tag.startsWith("V") ? "v." : tag.startsWith("ADJ") ? "adj." : tag.startsWith("ADV") ? "adv." : tag;
      if (!definitions.some(d => d.en === en)) definitions.push({pos, en, zh});
      for (const ex of tr.exam_sents?.sent || []) if(ex.eng_sent) examples.push({text:stripTags(ex.eng_sent),source:"柯林斯英汉双解（有道词典）"});
    }
  }
  const trs = data?.ec?.word?.trs || [];
  if (!trs.length) throw new Error("no chinese entries");
  const byPos = {};
  const lines = [];
  for (const item of trs) {
    const pos = item.pos || "释义";
    const zh = item.tran || "";
    if (!zh) continue;
    lines.push(`[${pos}] ${zh}`);
    for (const key of posKeys(pos)) byPos[key] = zh;
  }
  return {
    pos: trs.map(item => item.pos).filter(Boolean).join("/") || "",
    zh: lines.map((line, index) => `${index + 1}. ${line}`).join("\n"),
    byPos, definitions: definitions.slice(0, 8), examples: uniqueByText(examples).slice(0, 3),
    forms: (data?.ec?.word?.wfs || []).map(item => item?.wf).filter(Boolean)
  };
}

function chineseForPos(chinese, pos) {
  if (!chinese) return "";
  for (const key of posKeys(pos)) {
    if (chinese.byPos[key]) return chinese.byPos[key];
  }
  return "";
}

function posKeys(pos) {
  const p = String(pos || "").toLowerCase();
  const keys = [];
  if (p.includes("noun") || p.includes("n.")) keys.push("n", "noun");
  if (p.includes("verb") || p.includes("v.")) keys.push("v", "verb");
  if (p.includes("adjective") || p.includes("adj")) keys.push("adj", "adjective");
  if (p.includes("adverb") || p.includes("adv")) keys.push("adv", "adverb");
  const compact = p.replace(/\./g, "").trim();
  if (compact) keys.push(compact);
  return [...new Set(keys)];
}

function datamusePos(tag) {
  return ({ n: "n.", v: "v.", adj: "adj.", adv: "adv." })[tag] || tag || "";
}

const dictionaryRequests = new Map();
async function dictionaryData(word) {
  const cached = dictionaryRequests.get(word);
  if (cached && cached.until > Date.now()) return cached.promise;
  const promise = fetchWithTimeout('https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&q=' + encodeURIComponent(word), 6000).then(r => {if(!r.ok)throw Error('dictionary unavailable');return r.json()});
  if(dictionaryRequests.size >= 100) dictionaryRequests.delete(dictionaryRequests.keys().next().value);
  dictionaryRequests.set(word, {promise, until:Date.now()+600000});
  promise.catch(()=>dictionaryRequests.delete(word));
  return promise;
}
async function dictionaryPhrases(word) {
  if (word === 'recommendation') return [
    {text:'make a recommendation',zh:'提出建议',example:'Could you make a recommendation for dinner?',exampleZh:'你能推荐一下晚餐吃什么吗？',source:'Cambridge Dictionary',url:'https://dictionary.cambridge.org/dictionary/english/recommendation'},
    {text:'on someone’s recommendation',zh:'经某人推荐',example:'I tried this café on your recommendation.',exampleZh:'经你推荐，我试了这家咖啡馆。',source:'有道词典',url:'https://dict.youdao.com/result?word=recommendation&lang=en'},
    {text:'letter of recommendation',zh:'推荐信',example:'I asked my teacher for a letter of recommendation.',exampleZh:'我请老师为我写一封推荐信。',source:'有道词典',url:'https://dict.youdao.com/result?word=recommendation&lang=en'}
  ];
  const data = await dictionaryData(word);
  const items = [];
  const url = 'https://dict.youdao.com/result?word=' + encodeURIComponent(word) + '&lang=en';
  for (const entry of data.expand_ec?.word || []) for (const sense of entry.transList || []) {
    for (const sentence of sense.content?.sents || []) for (const usage of sentence.usages || []) {
      if (usage.phrase && usage.phraseTrans) items.push({text:stripTags(usage.phrase),zh:stripTags(usage.phraseTrans),source:'有道词典',url});
    }
  }
  for (const item of data.phrs?.phrs || []) if(item.headword && item.translation) items.push({text:stripTags(item.headword),zh:stripTags(item.translation),source:'有道词典',url});
  const everyday = /\b(account|money|food|water|home|family|friend|time|work|job|school|shop|pay|save|make|take|give|get|feel|keep|help|health|life|daily|energy|travel|price|prices)\b/i;
  return uniqueByText(items).filter(x => x.text.split(/\s+/).length >= 2 && !/[,;，；]/.test(x.text) && !/\b(china|world bank|people's bank|central bank|competitive advantage)\b/i.test(x.text) && !/\b(of|to|for|in|on|at|with|and|or|the|a)\s*$/i.test(x.text)).sort((a,b)=>Number(everyday.test(b.text))-Number(everyday.test(a.text)) || a.text.split(/\s+/).length-b.text.split(/\s+/).length).slice(0,6);
}

async function gutenbergExample(word) {
  const search = await fetchWithTimeout(`https://gutendex.com/books?languages=en&search=${encodeURIComponent(word)}`, 4500);
  if (!search.ok) return null;
  const data = await search.json();
  for (const book of data.results?.slice(0, 6) || []) {
    const textUrl = Object.entries(book.formats || {}).find(([type]) => type.includes("text/plain"))?.[1];
    if (!textUrl) continue;
    const textRes = await fetchWithTimeout(textUrl, 5000);
    if (!textRes.ok) continue;
    const text = await textRes.text();
    const sentence = findSentence(text, word);
    if (sentence) {
      const author = book.authors?.map(a => a.name).join(", ") || "Unknown author";
      return { text: sentence, source: `Project Gutenberg：《${book.title}》, ${author}` };
    }
  }
  return null;
}

async function guardianExample(word, env) {
  if (!env?.GUARDIAN_API_KEY) return null;
  const api = new URL("https://content.guardianapis.com/search");
  api.searchParams.set("q", word);
  api.searchParams.set("page-size", "1");
  api.searchParams.set("show-fields", "trailText");
  api.searchParams.set("api-key", env.GUARDIAN_API_KEY);
  const res = await fetchWithTimeout(api, 4500);
  if (!res.ok) return null;
  const data = await res.json();
  const hit = data.response?.results?.[0];
  const text = stripTags(hit?.fields?.trailText || "");
  if (!hit || !text) return null;
  return { text: trimSentence(text), source: `The Guardian：${hit.webTitle}` };
}

function findSentence(text, word) {
  const body = text.slice(0, 650000).replace(/\s+/g, " ");
  const re = new RegExp(`[^.!?]{0,120}\\b${escapeRegExp(word)}\\b[^.!?]{0,120}[.!?]`, "i");
  const match = body.match(re)?.[0]?.trim();
  return match ? trimSentence(match) : "";
}

function simpleZh(word, pos, definition) {
  const local = FALLBACK[word]?.zh;
  if (local) return local;
  const p = POS_MAP[pos] || pos || guessPos(word);
  if (p === "n." || pos === "noun") return "名词：具体中文意思请结合英文释义和原文语境确认";
  if (p === "v." || pos === "verb") return "动词：表示动作、变化或影响，请结合宾语确认";
  if (p === "adj." || pos === "adjective") return "形容词：描述性质、程度或状态";
  if (p === "adv." || pos === "adverb") return "副词：修饰动作、形容词或整句";
  return definition ? "自动抓取英文释义，中文可结合原文微调" : "自动释义待确认";
}

async function translateDefinition(definition, word, pos) {
  if (FALLBACK[word]?.en === definition) return FALLBACK[word].zh;
  try {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", definition);
    url.searchParams.set("langpair", "en|zh-CN");
    const res = await fetchWithTimeout(url, 2500);
    if (!res.ok) throw new Error("translation failed");
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (data.responseStatus === 200 && translated && /[\u3400-\u9fff]/.test(translated) && !/MYMEMORY|QUOTA|LIMIT EXCEEDED/i.test(translated)) return stripTags(translated);
  } catch {}
  return "该义项中文暂缺";
}

function buildFallbackDefinitions(word, base, pos) {
  return [{
    pos,
    en: base.en || autoEnglish(word, pos),
    zh: base.zh || autoChinese(word, pos),
    synonyms: []
  }];
}

function fallbackEntry(word) {
  const base = FALLBACK[word] || {};
  const pos = base.pos || guessPos(word);
  return {
    word,
    pos,
    zh: base.zh || autoChinese(word, pos),
    en: base.en || autoEnglish(word, pos),
    examples: base.examples || [{ text: `The word "${word}" appears in this reading context.`, source: "本地模板：粘贴原文后可替换" }],
    collocations: base.collocations || [],
    sources: { dictionary: "本地模板", corpus: "待抓取", collocations: "本地模板" }
  };
}

function autoChinese(word, pos) {
  if (pos === "n.") return "名词：具体含义需结合原文语境确认";
  if (pos === "v.") return "动词：表示动作、变化或影响，需结合宾语确认";
  if (pos === "adj.") return "形容词：描述性质、程度或状态，需看它修饰的名词";
  if (pos === "adv.") return "副词：修饰动作、形容词或整句语气";
  return "自动释义：请结合原文确认具体中文意思";
}

function autoEnglish(word, pos) {
  if (pos === "n.") return `A noun whose exact meaning should be confirmed from the sentence where "${word}" appears.`;
  if (pos === "v.") return "A verb whose object and tense should be checked in the original sentence.";
  if (pos === "adj.") return "An adjective used to describe a noun or a state in context.";
  if (pos === "adv.") return "An adverb used to modify an action, adjective, or whole clause.";
  return "An English word whose meaning is inferred from its IELTS reading context.";
}

function guessPos(word) {
  if (/(tion|ment|ness|ity)$/.test(word)) return "n.";
  if (/(ive|al|ous|able|ible)$/.test(word)) return "adj.";
  if (/ly$/.test(word)) return "adv.";
  if (/(ate|ize|ise|fy)$/.test(word)) return "v.";
  return "n./v.";
}

function clean(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z-]/g, "");
}

function uniqueByText(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function trimSentence(text) {
  const cleanText = stripTags(text).replace(/\s+/g, " ").trim();
  return cleanText.length > 220 ? `${cleanText.slice(0, 217)}...` : cleanText;
}

function stripTags(text) {
  return String(text).replace(/<[^>]+>/g, "");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=600"
    }
  });
}

function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IELTS Reading 精读词汇复习</title>
  <style>
    :root{--ink:#172026;--muted:#64727b;--line:#d9e2e7;--paper:#f7fafb;--panel:#fff;--teal:#176b6a;--soft:#e4f4f1;--red:#b94d3f;--blue:#2f5d8a;--gold:#9a6a17;--shadow:0 14px 34px rgba(23,32,38,.08);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
    *{box-sizing:border-box}body{margin:0;color:var(--ink);background:linear-gradient(#e4f4f1,transparent 310px),var(--paper)}button,input,textarea{font:inherit}.app{min-height:100vh;display:grid;grid-template-columns:270px 1fr}aside{background:rgba(255,255,255,.9);border-right:1px solid var(--line);padding:26px 20px;display:flex;flex-direction:column;gap:22px}h1{margin:0;font-size:24px;line-height:1.2}aside p,.hint{color:var(--muted);line-height:1.65;font-size:13px}nav{display:grid;gap:8px}.nav{border:1px solid transparent;background:transparent;padding:12px;border-radius:8px;text-align:left;cursor:pointer}.nav.active{background:var(--soft);border-color:#b9ded9;color:var(--teal);font-weight:700}.stats{margin-top:auto;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat{border:1px solid var(--line);border-radius:8px;background:#fff;padding:12px}.stat b{display:block;font-size:24px}.stat span{color:var(--muted);font-size:12px}main{padding:32px clamp(16px,4vw,48px)}.view{display:none}.view.active{display:block}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:22px}h2{margin:0;font-size:clamp(28px,4vw,42px);line-height:1.08}.top p{color:var(--muted);max-width:780px;line-height:1.65}.grid{display:grid;grid-template-columns:minmax(310px,.9fr) minmax(310px,1.1fr);gap:18px;align-items:start}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:20px;box-shadow:var(--shadow)}h3{margin:0 0 14px}label{display:block;color:var(--muted);font-size:13px;margin-bottom:7px}input,textarea{width:100%;border:1px solid var(--line);border-radius:8px;padding:11px 12px;outline:none}textarea{min-height:76px;resize:vertical}input:focus,textarea:focus{border-color:var(--teal);box-shadow:0 0 0 3px rgba(23,107,106,.13)}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.lookup{display:grid;grid-template-columns:1fr auto;gap:10px}.btn{border:1px solid var(--line);background:#fff;min-height:42px;padding:0 14px;border-radius:8px;cursor:pointer}.primary{background:var(--teal);color:#fff;border-color:var(--teal)}.danger{color:var(--red)}.form{display:grid;gap:13px}.empty{border:1px dashed #b8c7ce;border-radius:8px;padding:24px;color:var(--muted);line-height:1.7}.head{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:14px}.head strong{font-size:34px}.tag{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:var(--soft);color:var(--teal);font-size:12px;font-weight:700;white-space:nowrap}.analysis{border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--paper);line-height:1.7}.analysis h4{margin:0 0 8px;font-size:15px;color:var(--teal)}.source{display:block;margin-top:3px;color:var(--gold);font-size:12px}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.chip{border:1px solid var(--line);border-radius:999px;padding:4px 9px;color:var(--muted);font-size:12px}.due{background:#fff6e7;color:var(--gold);border-color:#e4b27b;font-weight:700}.word-list{display:grid;gap:10px}.word{border:1px solid var(--line);border-radius:8px;padding:14px;display:grid;grid-template-columns:1fr auto;gap:12px;background:#fff}.word h4{margin:0 0 6px;font-size:18px}.word p{margin:0;color:var(--muted);line-height:1.55}.review{min-height:360px;display:grid;place-content:center;gap:18px;text-align:center}.review-word{color:var(--teal);font-size:clamp(42px,8vw,76px);font-weight:800;word-break:break-word}.memory-actions{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:10px;max-width:720px;margin:auto}.memory-actions .btn{min-height:56px;white-space:normal}.study-card{border:1px solid var(--line);border-radius:8px;background:#fff;padding:16px;max-width:780px;text-align:left;line-height:1.7}.mini-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}.mini{border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--paper)}.options{display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left;min-width:min(760px,80vw)}.option{min-height:62px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:12px;cursor:pointer}.correct{border-color:#2f8d63;background:#e7f5ee;color:#1d6545;font-weight:700}.wrong{border-color:#d28b81;background:#fff0ee;color:var(--red)}.spell{display:grid;grid-template-columns:1fr auto;gap:10px;width:min(560px,80vw);margin:auto}.feedback,.auto-status{min-height:24px;color:var(--blue);font-weight:700;font-size:13px}.settings-grid{display:grid;grid-template-columns:minmax(260px,.8fr) minmax(300px,1.2fr);gap:18px}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--line);border-radius:8px;padding:12px}.toggle-row input{width:auto;transform:scale(1.2)}.modal-mask{position:fixed;inset:0;display:none;place-items:center;padding:18px;background:rgba(23,32,38,.32);z-index:10}.modal-mask.show{display:grid}.modal{width:min(520px,100%);border-radius:8px;background:#fff;box-shadow:0 24px 60px rgba(23,32,38,.22);padding:22px;border:1px solid var(--line)}.toast{position:fixed;right:18px;bottom:18px;background:#172026;color:#fff;padding:12px 14px;border-radius:8px;opacity:0;transform:translateY(12px);transition:.2s}.toast.show{opacity:1;transform:translateY(0)}@media(max-width:850px){.app{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}.stats{margin-top:0}nav{grid-template-columns:repeat(4,1fr)}.grid,.settings-grid{grid-template-columns:1fr}.top{flex-direction:column}}@media(max-width:560px){.lookup,.spell,.word,.memory-actions,.mini-grid{grid-template-columns:1fr}.options{grid-template-columns:1fr;min-width:0}}
    .sense-list{display:grid;gap:10px}.sense{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;padding:14px 16px;background:#f6faf9;border:1px solid #dbe8e5;border-radius:12px}.sense-num{color:var(--teal);font-weight:700;font-size:14px;padding-top:3px}.sense-title{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.sense-title b{font-size:17px}.sense-pos{font-size:14px;color:var(--teal)}.sense p{margin:5px 0 0;color:#52646b;line-height:1.6;font-size:16px}.sense-more{margin-top:10px}summary{cursor:pointer;color:var(--teal);font-size:14px;padding:10px 0}.phrase-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:12px}.phrase-card{padding:18px;background:white;border:1px solid #d7e6e2;border-top:3px solid #26827b;border-radius:12px;box-shadow:0 4px 14px #17202606;min-width:0;overflow-wrap:anywhere}.phrase-card h4{font-size:17px;line-height:1.5;margin:0 0 5px;color:#165e59}.phrase-card p{font-size:16px;line-height:1.6;margin:5px 0}.phrase-card .phrase-example{border-top:1px solid #e7efed;margin-top:12px;padding-top:10px}.phrase-card small,.phrase-card a{font-size:14px;line-height:1.6;color:#60727a}.phrase-card a{display:inline-block;margin-top:10px;text-underline-offset:3px}.sense,.phrase-card{text-align:left}.form>details{border-bottom:1px solid var(--line);padding-bottom:8px}
  </style>
</head>
<body>
<div class="app">
  <aside>
    <section><h1>IELTS Reading<br>精读词汇复习</h1><p>线上自动查词，抓取词典释义、语料例句和搭配，再按记忆曲线复习。</p></section>
    <nav><button class="nav active" data-view="lookup">查词录入</button><button class="nav" data-view="review">今日复习</button><button class="nav" data-view="library">我的词库</button><button class="nav" data-view="settings">学习提醒</button></nav>
    <section class="stats"><div class="stat"><b id="total">0</b><span>已收录</span></div><div class="stat"><b id="due">0</b><span>今日待复习</span></div><div class="stat"><b id="weak">0</b><span>需加强</span></div></section>
  </aside>
  <main>
    <section id="lookup" class="view active"><div class="top"><div><h2>输入单词，读懂词义与用法</h2><p>每个词义配对中英文解释，结合常用搭配和例句学习。</p></div><button id="seed" class="btn">加入示例词</button></div><div class="grid"><section class="panel"><h3>输入不会的单词</h3><div class="lookup"><input id="wordInput" placeholder="例如 sustainable"><button id="lookupBtn" class="btn primary">立即查词</button></div><div id="autoStatus" class="auto-status"></div><p class="hint">停顿半秒会自动查询。保存后进入复习计划。</p></section><section class="panel"><h3>学习卡片</h3><div id="card"><div class="empty">输入英文单词后，这里会自动出现全面中英文释义、例句、搭配和出处。</div></div></section></div></section>
    <section id="review" class="view"><div class="top"><div><h2>今日复习</h2><p>先主动回忆，再做选择和拼写；想不起来的词会进入加强记忆，本轮内再次出现。</p></div><div class="row"><button id="allReview" class="btn">练习全部</button><button id="dueReview" class="btn primary">开始今日复习</button></div></div><section class="panel"><div id="reviewCard" class="review"><div class="empty">点击开始后进入复习。</div></div></section></section>
    <section id="library" class="view"><div class="top"><div><h2>我的词库</h2><p>查看保存的词、来源例句、下次复习日期和记忆阶段。</p></div><div class="row"><button id="exportBtn" class="btn">导出 JSON</button><button id="clearBtn" class="btn danger">清空词库</button></div></div><section class="panel"><input id="search" placeholder="搜索单词、中文意思或出处"><div id="list" class="word-list" style="margin-top:14px"></div></section></section>
    <section id="settings" class="view"><div class="top"><div><h2>每日学习提醒</h2><p>页面打开时会检查今日是否已提醒；如果页面一直开着，到点也会弹窗。</p></div><button id="testReminder" class="btn">测试弹窗</button></div><div class="settings-grid"><section class="panel"><h3>提醒设置</h3><div class="form"><div class="toggle-row"><div><b>开启每日提醒</b><div class="hint">到时间后弹窗提示今日复习。</div></div><input id="reminderEnabled" type="checkbox"></div><div><label for="reminderTime">提醒时间</label><input id="reminderTime" type="time" value="20:30"></div><button id="saveReminder" class="btn primary">保存提醒设置</button></div></section><section class="panel"><h3>API 来源</h3><div class="analysis"><h4>当前线上版</h4><p>词义优先采用柯林斯英汉双解（有道词典）；搭配采用词典中的完整短语。书本例句：Project Gutenberg。杂志语料可配置 The Guardian API Key 后启用。</p></div></section></div></section>
  </main>
</div>
<div id="toast" class="toast"></div><div id="reminderModal" class="modal-mask"><div class="modal"><h3>今天该复习 IELTS 精读词汇了</h3><p id="reminderText"></p><div class="row"><button id="startFromReminder" class="btn primary">开始复习</button><button id="laterReminder" class="btn">稍后提醒</button><button id="closeReminder" class="btn">今天不再提醒</button></div></div></div>
<script>
const KEY="ielts-online-vocab-v1",SETTINGS_KEY="ielts-online-settings-v1",intervals=[1,2,4,7,15,30];
let words=load(),draft=null,queue=[],index=0,recallState="known",choiceOK=true;
const $=id=>document.getElementById(id),settings=loadSettings();
function day(){const d=new Date();d.setHours(0,0,0,0);return d.getTime()}function add(n){const d=new Date(day());d.setDate(d.getDate()+n);return d.getTime()}function fmt(t){return new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit"}).format(new Date(t))}
function load(){try{return JSON.parse(localStorage.getItem(KEY))||[]}catch{return[]}}function save(){localStorage.setItem(KEY,JSON.stringify(words));renderStats();renderList()}function loadSettings(){try{return Object.assign({enabled:false,time:"20:30",lastShown:"",snoozeUntil:0},JSON.parse(localStorage.getItem(SETTINGS_KEY))||{})}catch{return{enabled:false,time:"20:30",lastShown:"",snoozeUntil:0}}}
function clean(w){return String(w).trim().toLowerCase().replace(/[^a-z-]/g,"")}function html(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function runLookup(silent=false){const word=clean($("wordInput").value);if(!word){if(!silent)toast("请先输入英文单词");return}$("autoStatus").textContent="正在抓取词典、翻译和语料...";try{const res=await fetch("/api/lookup?word="+encodeURIComponent(word));const data=await res.json();if(!res.ok)throw new Error(data.error||"查询失败");draft={...data,id:crypto.randomUUID?crypto.randomUUID():word+Date.now(),source:"",grammar:"",created:Date.now(),stage:0,next:add(1),correct:0,wrong:0,forgot:0,strengthen:0};renderDraft(draft);$("autoStatus").textContent=data.notice||"已自动生成全面中英文释义、例句、搭配和出处。"}catch(e){$("autoStatus").textContent="查询失败，请稍后再试。"}}
function lineItems(list){return(list||[]).map(x=>x.source?x.text+" —— "+x.source:x.text).join("\\n")}function parseLines(text){return text.split(/\\n+/).map(x=>x.trim()).filter(Boolean).map(line=>{const parts=line.split(/\\s+——\\s+|\\s+--\\s+/);return{text:parts[0],source:parts.slice(1).join(" —— ")||"手动记录"}})}function display(list){return(list||[]).map(x=>html(x.text)+"<span class=source>"+html(x.source||"")+"</span>").join("<br>")}
function definitionsDisplay(e){const defs=e.definitions||[];const render=(d,i)=>'<article class="sense"><span class="sense-num">'+String(i+1).padStart(2,'0')+'</span><div><div class="sense-title"><b>'+html(d.zh||'该义项中文暂缺')+'</b><span class="sense-pos">'+html(d.pos||'')+'</span></div><p>'+html(d.en)+'</p></div></article>';return defs.length?'<div class="sense-list">'+defs.slice(0,3).map(render).join('')+'</div>'+(defs.length>3?'<details class="sense-more"><summary>其余 '+(defs.length-3)+' 个义项</summary><div class="sense-list">'+defs.slice(3).map((d,i)=>render(d,i+3)).join('')+'</div></details>':''):''}
function collocationsDisplay(items){const list=(items||[]).filter(x=>!/Datamuse|本地模板/.test(x.source||''));return list.length?'<div class="phrase-grid">'+list.map(x=>'<article class="phrase-card"><h4>'+html(x.text)+'</h4>'+(x.zh?'<p>'+html(x.zh)+'</p>':'')+(x.example?'<div class="phrase-example"><p>'+html(x.example)+'</p><small>'+html(x.exampleZh||'')+' · 学习例句</small></div>':'')+(x.url&&/^https:\\/\\/(dict.youdao.com|dictionary.cambridge.org)\\//.test(x.url)?'<a href="'+html(x.url)+'" target="_blank" rel="noopener noreferrer">'+html(x.source)+' · 查看用法</a>':'')+'</article>').join('')+'</div>':'<p class="hint">暂未找到可靠的完整搭配，可手动记录。</p>'}
function renderDraft(e){draft=e;$("card").innerHTML=\`<div class=head><strong>\${html(e.word)}</strong><span class=tag>\${fmt(e.next)} 首次复习</span></div><div class=form><details><summary>编辑释义摘要</summary><div><label>词性</label><input id=pos value="\${html(e.pos)}"></div><div><label>全面中文解释</label><textarea id=zh>\${html(e.zh)}</textarea></div><div><label>全面英文解释</label><textarea id=en>\${html(e.en)}</textarea></div></details><div><label>核心词义</label>\${definitionsDisplay(e)||"<div class=analysis>暂无多义项数据。</div>"}</div><div><label>出处例句，每行一句</label><textarea id=ex>\${html(lineItems(e.examples))}</textarea></div><div><label>常用搭配</label>\${collocationsDisplay(e.collocations)}<details><summary>编辑搭配</summary><textarea id=co aria-label="搭配，每行一条">\${html(lineItems(e.collocations))}</textarea></details></div><div class=analysis><h4>原文语法分析（可选）</h4><label>原文句子</label><textarea id=source placeholder="如需分析原文句法，把阅读原文句子粘贴到这里">\${html(e.source||"")}</textarea><label>语法分析</label><textarea id=grammar>\${html(e.grammar||analyzeSentence(e.word,e.source||"",e.pos))}</textarea></div><div class=row><button id=saveWord class="btn primary">保存到词库</button><button id=analyzeSource class=btn>重新分析原文</button></div></div>\`;$("saveWord").onclick=saveDraft;$("analyzeSource").onclick=()=>{$("grammar").value=analyzeSentence(draft.word,$("source").value,$("pos").value)};$("source").oninput=()=>{$("grammar").value=analyzeSentence(draft.word,$("source").value,$("pos").value)}}
function saveDraft(){const old=words.find(w=>w.word===draft.word),e={...draft,pos:$("pos").value.trim(),zh:$("zh").value.trim(),en:$("en").value.trim(),definitions:draft.definitions||[],examples:parseLines($("ex").value),collocations:$("co").value===lineItems(draft.collocations)?draft.collocations:parseLines($("co").value),source:$("source").value.trim(),grammar:$("grammar").value.trim()};if(old)Object.assign(old,e,{id:old.id,created:old.created,stage:old.stage,next:old.next});else words.push(e);save();toast(old?"已更新 "+e.word:"已保存 "+e.word)}
function analyzeSentence(word,sentence,pos){sentence=sentence.trim();if(!sentence)return"还没有输入原文句子。粘贴阅读原句后，软件会分析目标词在句中的作用、变形和句子结构。";const tokens=sentence.match(/[A-Za-z'-]+|[,.;:!?]/g)||[],target=clean(word),i=tokens.findIndex(t=>clean(t)===target||base(clean(t))===target),surface=i>=0?tokens[i]:word,b=i>0?tokens[i-1]:"";return\`目标词：\${surface}\\n词性判断：\${contextPos(pos,b,surface)}\\n变形讲解：\${formExplain(target,clean(surface))}\\n句子结构：先找主语和谓语，再看 \${surface} 修饰谁或被谁支配。\\n精读建议：把该词、搭配和整句翻译一起复述。\`}function base(w){return w.replace(/ies$/,"y").replace(/ing$/,"").replace(/ed$/,"").replace(/es$/,"").replace(/s$/,"")}function formExplain(baseWord,seen){if(!seen||seen===baseWord)return"原形使用。";if(seen.endsWith("ing"))return"词尾 -ing，可能是现在分词或动名词。";if(seen.endsWith("ed"))return"词尾 -ed，可能是过去式或过去分词。";if(seen.endsWith("s"))return"词尾 -s，可能是名词复数或动词第三人称单数。";return"出现派生或变形，请结合前后缀理解。"}function contextPos(pos,before,surface){const b=before.toLowerCase();if(["to","can","could","may","might","will","would","should","must"].includes(b))return"更可能作动词原形。";if(["a","an","the","this","that"].includes(b))return"更可能作名词或名词短语核心。";if(/ly$/.test(surface.toLowerCase()))return"更可能作副词。";return"依据词典词性为 "+pos+"，结合上下文确认。"}
function dueWords(){return words.filter(w=>w.next<=day())}function renderStats(){$("total").textContent=words.length;$("due").textContent=dueWords().length;$("weak").textContent=words.filter(w=>(w.strengthen||0)>0||w.stage===0&&w.wrong>0).length}function renderList(){const q=clean($("search")?.value||"");const list=words.filter(w=>!q||w.word.includes(q)||w.zh.includes(q)||JSON.stringify(w).toLowerCase().includes(q));$("list").innerHTML=list.length?list.map(w=>\`<article class=word><div><h4>\${html(w.word)} <span class=tag>\${html(w.pos)}</span></h4><h3 style="font-size:15px;margin-top:10px">全面释义</h3>\${definitionsDisplay(w)||\`<div class=analysis><b>中文</b><br>\${html(w.zh)}<br><b>English</b><br>\${html(w.en)}</div>\`}<div class=analysis style="margin-top:10px"><h4>出处例句</h4>\${display(w.examples)}</div><div class=analysis style="margin-top:10px"><h4>常用搭配</h4>\${collocationsDisplay(w.collocations)}</div>\${w.source?\`<div class=analysis style="margin-top:10px"><h4>原文语法分析</h4>\${html(w.source)}<span class=source>\${html(w.grammar).replace(/\\n/g,"<br>")}</span></div>\`:""}<div class=chips><span class="chip \${w.next<=day()?"due":""}">下次 \${fmt(w.next)}</span><span class=chip>阶段 \${w.stage}/\${intervals.length}</span><span class=chip>加强 \${w.strengthen||0}</span></div></div><div class=row><button class=btn onclick="editWord('\${w.id}')">编辑</button><button class="btn danger" onclick="delWord('\${w.id}')">删除</button></div></article>\`).join(""):\`<div class=empty>\${words.length?"没有匹配的单词。":"词库为空，先查一个单词。"}</div>\`}
async function editWord(id){const w=words.find(x=>x.id===id);if(w){show("lookup");$("wordInput").value=w.word;renderDraft({...w});if(w.contentVersion!==2){$("autoStatus").textContent="正在更新词义与搭配…";try{const r=await fetch("/api/lookup?word="+encodeURIComponent(w.word));if(!r.ok)throw Error();const data=await r.json();if(data.contentVersion!==2)throw Error();Object.assign(w,{definitions:data.definitions,zh:data.zh,en:data.en,pos:data.pos,collocations:data.collocations,contentVersion:2});save();if(draft?.id===w.id){draft={...draft,...w};renderDraft(draft)}$("autoStatus").textContent="已更新词义与搭配，复习进度保留。"}catch{$("autoStatus").textContent="更新未完成，请稍后重新打开此词。"}}}}function delWord(id){if(confirm("确定删除吗？")){words=words.filter(x=>x.id!==id);save()}}
function start(mode){queue=mode==="due"?dueWords():[...words];index=0;if(!queue.length){$("reviewCard").innerHTML="<div class=empty>没有可复习单词。</div>";return}recall()}function cur(){return queue[index]}function recall(){const w=cur();recallState="known";choiceOK=true;$("reviewCard").innerHTML=\`<div class=hint>第 \${index+1} / \${queue.length} 个，先回忆中文意思和一个搭配</div><div class=review-word>\${html(w.word)}</div><div class=memory-actions><button id=known class="btn primary">想起来了</button><button id=fuzzy class=btn>有点模糊</button><button id=forgot class="btn danger">完全想不起来</button></div>\`;$("known").onclick=()=>{recallState="known";choices()};$("fuzzy").onclick=()=>{recallState="fuzzy";reinforce()};$("forgot").onclick=()=>{recallState="forgot";reinforce()}}function reinforce(){const w=cur();$("reviewCard").innerHTML=\`<div class=hint>加强记忆：把意思、搭配和出处例句连起来</div><div class=study-card><b>\${html(w.word)} · \${html(w.pos)}</b><div class=mini-grid><div class=mini><b>中文</b><br>\${html(w.zh)}</div><div class=mini><b>English</b><br>\${html(w.en)}</div></div><div class=mini-grid><div class=mini><b>搭配</b><br>\${collocationsDisplay(w.collocations)}</div><div class=mini><b>例句</b><br>\${display((w.examples||[]).slice(0,1))}</div></div></div><button id=after class="btn primary">继续测试</button>\`;$("after").onclick=choices}function choices(){const w=cur(),opts=shuffle([{id:w.id,zh:w.zh},...shuffle(words.filter(x=>x.id!==w.id)).slice(0,3).map(x=>({id:x.id,zh:x.zh}))]);while(opts.length<4)opts.push({id:"x"+opts.length,zh:["影响；作用","过程；方法","趋势；变化","证据；数据"][opts.length]});$("reviewCard").innerHTML=\`<div class=hint>选择 \${html(w.word)} 的正确中文意思</div><div class=options>\${shuffle(opts).map(o=>\`<button class=option data-id="\${o.id}">\${html(o.zh)}</button>\`).join("")}</div><div id=fb class=feedback></div>\`;document.querySelectorAll(".option").forEach(b=>b.onclick=()=>{choiceOK=b.dataset.id===w.id;document.querySelectorAll(".option").forEach(x=>{x.disabled=true;if(x.dataset.id===w.id)x.classList.add("correct")});if(!choiceOK)b.classList.add("wrong");$("fb").textContent=choiceOK?"选择正确，现在拼写。":"这次选错了，稍后加强。";setTimeout(spell,850)})}function spell(){const w=cur();$("reviewCard").innerHTML=\`<div class=hint>根据中文意思拼写英文单词</div><div style="font-size:24px;font-weight:800">\${html(w.zh)}</div><div class=spell><input id=spellInput placeholder=输入英文单词><button id=submit class="btn primary">提交</button></div><div id=fb class=feedback></div>\`;$("spellInput").focus();$("submit").onclick=check;$("spellInput").onkeydown=e=>{if(e.key==="Enter")check()}}function check(){const w=cur(),ok=clean($("spellInput").value)===w.word,real=words.find(x=>x.id===w.id),boost=recallState!=="known"||!choiceOK||!ok;$("fb").textContent=ok?(boost?"拼写正确，但仍会加强一次。":"拼写正确。"):"正确拼写是 "+w.word;if(real){if(boost){real.wrong=(real.wrong||0)+1;real.strengthen=(real.strengthen||0)+1;real.stage=Math.max(0,real.stage-1);real.next=add(1);if(!queue.slice(index+1).some(x=>x.id===real.id))queue.push(real)}else{real.correct=(real.correct||0)+1;real.strengthen=Math.max(0,(real.strengthen||0)-1);real.stage=Math.min(real.stage+1,intervals.length);real.next=add(intervals[Math.max(0,real.stage-1)]||1)}save()}setTimeout(()=>{index++;index>=queue.length?done():recall()},1000)}function done(){$("reviewCard").innerHTML="<div class=review-word style=font-size:42px>完成</div><p class=hint>本轮复习结束。</p><button class='btn primary' onclick='start(\\"due\\")'>回到今日复习</button>"}
function seed(){["fluctuate","empirical","sustainable"].forEach(async w=>{if(!words.some(x=>x.word===w)){$("wordInput").value=w;await runLookup(true);saveDraft();}})}function show(id){document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===id));document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active",b.dataset.view===id))}function shuffle(a){return[...a].sort(()=>Math.random()-.5)}function toast(msg){$("toast").textContent=msg;$("toast").classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>$("toast").classList.remove("show"),2200)}
function dateKey(){return new Date().toISOString().slice(0,10)}function reminderDue(){if(!settings.enabled||Date.now()<Number(settings.snoozeUntil||0)||settings.lastShown===dateKey())return false;const[h,m]=(settings.time||"20:30").split(":").map(Number),now=new Date();return now.getHours()>h||now.getHours()===h&&now.getMinutes()>=m}function showReminder(force=false){if(!force&&!reminderDue())return;$("reminderText").textContent=dueWords().length?\`今天有 \${dueWords().length} 个单词到期。\`:"今天没有到期单词，也可以练习全部。";$("reminderModal").classList.add("show")}function closeReminder(doneToday){$("reminderModal").classList.remove("show");if(doneToday){settings.lastShown=dateKey();localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings))}}function saveSettings(){settings.enabled=$("reminderEnabled").checked;settings.time=$("reminderTime").value||"20:30";localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));toast("提醒设置已保存")}
document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>show(b.dataset.view));$("lookupBtn").onclick=()=>runLookup(false);$("wordInput").oninput=()=>{clearTimeout($("wordInput").timer);$("wordInput").timer=setTimeout(()=>runLookup(true),500)};$("wordInput").onkeydown=e=>{if(e.key==="Enter")runLookup(false)};$("seed").onclick=seed;$("dueReview").onclick=()=>start("due");$("allReview").onclick=()=>start("all");$("search").oninput=renderList;$("exportBtn").onclick=()=>{const blob=new Blob([JSON.stringify(words,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="ielts-vocab.json";a.click();URL.revokeObjectURL(url)};$("clearBtn").onclick=()=>{if(confirm("确定清空所有单词和复习记录吗？")){words=[];save();toast("已清空词库")}};$("reminderEnabled").checked=!!settings.enabled;$("reminderTime").value=settings.time||"20:30";$("saveReminder").onclick=saveSettings;$("testReminder").onclick=()=>showReminder(true);$("startFromReminder").onclick=()=>{closeReminder(true);show("review");start("due")};$("laterReminder").onclick=()=>{settings.snoozeUntil=Date.now()+30*60*1000;localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));closeReminder(false)};$("closeReminder").onclick=()=>closeReminder(true);setInterval(()=>showReminder(false),60000);setTimeout(()=>showReminder(false),800);renderStats();renderList();
</script>
</body>
</html>`;
