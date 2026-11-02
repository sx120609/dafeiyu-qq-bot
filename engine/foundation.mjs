// Foundation behaviour the WeChatAIBot ports share: JSONSerialization's output and its `as?` casts, and the
// ICU regex semantics NSRegularExpression uses where JS differs.

/** JSONSerialization.data(withJSONObject:) / JSONEncoder output as text. Both escape "/" as "\/" by default, which
 *  only matters where the text itself is shown to a model or its length is budgeted. */
export function serialize(value, {sortedKeys = false} = {}) {
  return JSON.stringify(sortedKeys ? sortKeys(value) : value).replaceAll('/', '\\/');
}
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isDictionary(value)) {
    if (typeof value.toJSON === 'function') return sortKeys(value.toJSON());
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}

/** `try JSONSerialization.jsonObject(with:)`: top level must be an object or array; throws otherwise. */
export function jsonObject(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object') throw new SyntaxError('JSON text did not start with array or object');
  return value;
}
/** `try? JSONSerialization.jsonObject(with:) as? [String: Any]` */
export function parseDictionary(data) {
  try { const value = jsonObject(data); return isDictionary(value) ? value : undefined; } catch { return undefined; }
}

export const isDictionary = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
/** `as? Int` */
export const asInt = value => typeof value === 'number' && Number.isInteger(value) ? value : undefined;
/** `as? Double` */
export const asDouble = value => typeof value === 'number' ? value : undefined;
/** `as? String` */
export const asString = value => typeof value === 'string' ? value : undefined;
/** `as? Bool` */
export const asBool = value => typeof value === 'boolean' ? value : undefined;
/** `as? [String: Any]` */
export const asDictionary = value => isDictionary(value) ? value : undefined;
/** `as? [[String: Any]]` — fails as a whole when any element is not a dictionary. */
export const asDictionaries = value => Array.isArray(value) && value.every(isDictionary) ? value : undefined;
/** `as? [String]` */
export const asStrings = value => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
/** `as? [String: String]` */
export const asStringDictionary = value => isDictionary(value) && Object.values(value).every(item => typeof item === 'string') ? value : undefined;
/** `Set(object.keys) == [...]` */
export const keysEqual = (object, keys) => {
  const actual = Object.keys(object);
  return actual.length === new Set(keys).size && actual.every(key => keys.includes(key));
};
/** `String(describing:)` of a JSON value. */
export const describing = value => typeof value === 'string' ? value : value === null ? '<null>' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** NSRegularExpression's `\w` (ICU): letters, marks, decimal digits and connector punctuation from all scripts. */
export const icuWord = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}‌‍]`;
/** ICU `\b` as lookarounds over icuWord (JS `\b` only knows ASCII word characters). */
export const icuBoundary = String.raw`(?:(?<=${icuWord})(?!${icuWord})|(?<!${icuWord})(?=${icuWord}))`;

/** Swift 6 `URL(string:)` (which percent-encodes invalid characters rather than failing) with the component
 *  accessors the engine checks: scheme, host, user, password, port, path (decoded), query and fragment are
 *  undefined when absent, as Swift's are nil. WHATWG drops a default port ("https://h:443/") and an empty "?";
 *  Swift keeps both, so they are read from the raw text. `href` is the parsed, encoded form. Returns undefined
 *  where parsing fails (a relative reference, which callers would reject for its missing scheme anyway). */
export function swiftURL(value) {
  const text = String(value ?? '');
  let url;
  try { url = new URL(text); } catch { return undefined; }
  const raw = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/s.exec(text);
  if (!raw) return undefined;
  const authority = raw[3];
  let userinfo, hostPort = authority;
  if (authority !== undefined && authority.includes('@')) {
    userinfo = authority.slice(0, authority.lastIndexOf('@')); hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  }
  const portMatch = hostPort === undefined ? null : /:(\d*)$/.exec(hostPort.startsWith('[') ? hostPort.slice(hostPort.indexOf(']') + 1) : hostPort);
  let path = url.pathname;
  try { path = decodeURIComponent(url.pathname); } catch {}
  return {
    href: url.href, url, scheme: raw[1],
    // Swift keeps a valid string as written; one it had to percent-encode reads back encoded.
    absoluteString: /^[\x21-\x7e]+$/.test(text) ? text : url.href,
    host: authority === undefined || url.hostname === '' ? undefined : url.hostname.replace(/^\[|\]$/g, ''),
    user: userinfo === undefined ? undefined : userinfo.split(':')[0],
    password: userinfo === undefined || !userinfo.includes(':') ? undefined : userinfo.slice(userinfo.indexOf(':') + 1),
    port: portMatch && portMatch[1] !== '' ? Number(portMatch[1]) : undefined,
    path: authority === undefined ? raw[4] : path,
    query: raw[5] === undefined ? undefined : raw[5].slice(1),
    fragment: raw[6] === undefined ? undefined : raw[6].slice(1)
  };
}

const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Foundation's Data(base64Encoded:): undefined for anything that is not strict base64. */
export const decodeBase64 = value => typeof value === 'string' && base64.test(value) ? Buffer.from(value, 'base64') : undefined;

/** URLComponents.queryItems encoding: like encodeURIComponent, but "$+,;:@/?" stay literal as Foundation leaves
 *  them (so a literal "+" reads as a space on the server, exactly as from the Swift engine). */
export function urlQuery(items) {
  const encode = value => encodeURIComponent(String(value)).replace(/%(24|2B|2C|3B|3A|40|2F|3F)/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return items.map(([name, value]) => encode(name) + '=' + encode(value)).join('&');
}
/** URLComponents.path setter encoding ("/" kept, everything outside the path-allowed set percent-encoded). */
export function urlPath(value) {
  return String(value).split('/').map(part => encodeURIComponent(part).replace(/%(24|26|2B|2C|3B|3D|3A|40)/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))).join('/');
}

/** JSONDecoder's failure on input that does not match the expected Decodable shape. */
export class DecodingError extends Error {
  constructor(detail) { super('The data couldn’t be read because it isn’t in the correct format.'); this.name = 'DecodingError'; this.detail = detail; }
}

/** A Swift value copy: the type's clone() when it has one, else a deep copy keeping prototypes. */
export function copy(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.clone === 'function') return value.clone();
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(copy);
  if (value instanceof Set) return new Set([...value].map(copy));
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, copy(item)]));
  const result = Object.create(Object.getPrototypeOf(value));
  for (const key of Object.keys(value)) result[key] = copy(value[key]);
  return result;
}
/** Swift `==` on Equatable values: the type's equals() when it has one, else structural equality. */
export function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object' || typeof b !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a.equals === 'function') return a.equals(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (a instanceof Set || b instanceof Set) return a instanceof Set && b instanceof Set && a.size === b.size && [...a].every(item => b.has(item));
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!same(a[key], b[key])) return false;
  return true;
}
