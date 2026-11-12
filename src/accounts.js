export function csrfCode(key) {
  if (!key) return "";
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash += (hash << 5) + key.charCodeAt(i);
  }
  return String(hash & 0x7fffffff);
}

export function normalizeUin(value) {
  return String(value ?? "").replace(/^o|g$/gi, "").replace(/\D/g, "");
}

function cookieValue(cookie, name) {
  const match = String(cookie).match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function parseAccount(input, index = 0) {
  if (!input || typeof input !== "object") {
    throw invalid(`账号 #${index + 1} 不是对象`);
  }

  const cookie = input.cookie || input.cookies || "";
  const cookieText = Array.isArray(cookie)
    ? cookie.filter((item) => item && /tencent\.com|orcaterm/i.test(item.domain || "")).map((item) => `${item.name}=${item.value}`).join("; ")
    : String(cookie);
  const uin = normalizeUin(input.uin || cookieValue(cookieText, "uin"));
  const skey = input.skey || cookieValue(cookieText, "skey");
  const pSkey = input.p_skey || input.pSkey || cookieValue(cookieText, "p_skey");
  const key = skey || pSkey;

  if (!uin || !key) {
    throw invalid(`账号 #${index + 1} 缺少 uin 或 skey/p_skey`);
  }

  const extraCookies = [];
  for (const name of ["qcmainCSRFToken", "qcloud_uid", "language"]) {
    const value = input[name] || cookieValue(cookieText, name);
    if (value) extraCookies.push(`${name}=${value}`);
  }
  if (Array.isArray(input.extraCookies)) {
    for (const pair of input.extraCookies) {
      const name = String(pair).split("=")[0];
      if (name && !extraCookies.some((item) => item.startsWith(`${name}=`))) extraCookies.push(String(pair));
    }
  }

  return {
    id: String(input.id || input.name || uin),
    uin,
    skey,
    pSkey,
    key,
    csrf: csrfCode(key),
    extraCookies,
    disabled: Boolean(input.disabled),
  };
}

function recordsFromJson(parsed) {
  if (Array.isArray(parsed)) {
    if (parsed.some((item) => item && (item.name || item.domain))) return [{ cookies: parsed }];
    return parsed;
  }
  if (parsed && Array.isArray(parsed.accounts)) return parsed.accounts;
  if (parsed && Array.isArray(parsed.cookies)) return [{ cookies: parsed.cookies }];
  if (parsed && (parsed.cookie || parsed.uin || parsed.skey || parsed.p_skey)) return [parsed];
  throw invalid("无法识别 JSON 账号格式");
}

function recordFromNetscape(text) {
  const cookies = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const fields = line.split("\t");
    if (fields.length < 7) return null;
    return { domain: fields[0], name: fields[5], value: fields[6] };
  }).filter(Boolean);
  return cookies.length ? [{ cookies }] : [];
}

export function parseAccounts(text) {
  const source = String(text || "").trim();
  if (!source) return [];

  let records;
  if (source.startsWith("[") || source.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw invalid("账号内容不是合法 JSON");
    }
    records = recordsFromJson(parsed);
  } else if (source.includes("\t") && source.includes("TRUE")) {
    records = recordFromNetscape(source);
  } else {
    records = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      if (line.includes("uin=") || line.includes("skey=") || line.includes("p_skey=")) return { cookie: line };
      const parts = line.split(/[\s,|]+/);
      if (parts.length < 2) throw invalid(`无法解析账号行: ${line}`);
      return { uin: parts[0], skey: parts[1], p_skey: parts[2] || "" };
    });
  }

  return records.map(parseAccount);
}
