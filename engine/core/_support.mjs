// Helpers shared by the BotCore ports (engine/core/*.mjs): Swift Codable decoding/encoding, Foundation's
// JSONSerialization/JSONEncoder text, Character and CharacterSet predicates, ICU regex pieces and a small
// Gregorian Calendar. Not a Swift file of its own.
import {dateFromSwift, dateToSwift, graphemes} from '../swift.mjs';

// ---- Codable ----------------------------------------------------------------------------------------------

/** Swift's DecodingError (keyNotFound, valueNotFound, typeMismatch, dataCorrupted). */
export class DecodingError extends Error {
  constructor(message) { super(message); this.name = 'DecodingError'; }
}

// JSONEncoder/JSONDecoder date strategy in force. `.deferredToDate` (seconds since 2001) unless a call of
// encodeJSON/decodeJSON says otherwise; toJSON()/decode() of every type read it through encodeDate/decodeDate.
let dateStrategy = 'deferredToDate';
const withDates = (dates, body) => {
  const saved = dateStrategy;
  dateStrategy = dates;
  try { return body(); } finally { dateStrategy = saved; }
};
export const iso8601 = date => date.toISOString().replace(/\.\d+Z$/, 'Z');
export const encodeDate = date => date == null ? undefined : dateStrategy === 'iso8601' ? iso8601(date) : dateToSwift(date);
export const decodeDate = (value, where = 'date') => {
  if (dateStrategy === 'iso8601') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) throw new DecodingError(`${where}: expected an ISO 8601 date`);
    return new Date(value);
  }
  if (typeof value !== 'number') throw new DecodingError(`${where}: expected a number of seconds`);
  return dateFromSwift(value);
};
/** Foundation writes "/" as "\/" (JSONEncoder and JSONSerialization alike, unless .withoutEscapingSlashes). */
export const escapeSlashes = text => text.replace(/\//g, '\\/');
/** JSONEncoder().encode(value) as text; `dates: 'iso8601'` for an encoder with .iso8601. */
export const encodeJSON = (value, {dates = 'deferredToDate'} = {}) => withDates(dates, () => escapeSlashes(JSON.stringify(value)));
/** JSONDecoder().decode(Type.self, from: text); `dates: 'iso8601'` for a decoder with .iso8601. */
export const decodeJSON = (Type, text, {dates = 'deferredToDate'} = {}) => withDates(dates, () => Type.decode(JSON.parse(text)));

const fail = (where, what) => { throw new DecodingError(`${where}: expected ${what}`); };
export const decodeString = (v, where = 'value') => typeof v === 'string' ? v : fail(where, 'a string');
export const decodeInt = (v, where = 'value') => Number.isInteger(v) ? v : fail(where, 'an integer');
export const decodeDouble = (v, where = 'value') => typeof v === 'number' ? v : fail(where, 'a number');
export const decodeBool = (v, where = 'value') => typeof v === 'boolean' ? v : fail(where, 'a boolean');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** UUID(uuidString:) accepts either case; uuidString is upper case. */
export const decodeUUID = (v, where = 'value') => typeof v === 'string' && uuidPattern.test(v) ? v.toUpperCase() : fail(where, 'a UUID');
export const decodeRaw = Enum => (v, where = 'value') => Enum.all.includes(v) ? v : fail(where, `one of ${Enum.all.join(', ')}`);
export const decodeArray = item => (v, where = 'value') => Array.isArray(v) ? v.map((x, i) => item(x, `${where}[${i}]`)) : fail(where, 'an array');
/** [String: X] (a JSON object). */
export const decodeDict = item => (v, where = 'value') => v !== null && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, item(x, `${where}.${k}`)])) : fail(where, 'an object');
export const decodeType = Type => (v, where) => { try { return Type.decode(v); } catch (error) { if (error instanceof DecodingError && where) error.message = `${where}: ${error.message}`; throw error; } };

/** Reads one keyed container like synthesized Codable: `need` for non-optional keys, `maybe` for optionals. */
export const container = (json, type) => {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new DecodingError(`${type}: expected an object`);
  return {
    has: key => json[key] != null,
    need: (key, item) => {
      if (json[key] === undefined) throw new DecodingError(`${type}: key "${key}" not found`);
      if (json[key] === null) throw new DecodingError(`${type}: "${key}" is null`);
      return item(json[key], `${type}.${key}`);
    },
    maybe: (key, item) => json[key] == null ? undefined : item(json[key], `${type}.${key}`)
  };
};

/** Struct value semantics: a deep copy keeping prototypes, Dates, Sets and Maps. */
export const deepClone = value => {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(deepClone);
  if (value instanceof Set) return new Set([...value].map(deepClone));
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [deepClone(k), deepClone(v)]));
  const copy = Object.create(Object.getPrototypeOf(value));
  for (const key of Object.keys(value)) copy[key] = deepClone(value[key]);
  return copy;
};
/** Synthesized Equatable: undefined and missing keys are the same nil. */
export const deepEqual = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object' || typeof b !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof Set || b instanceof Set) return a instanceof Set && b instanceof Set && a.size === b.size && [...a].every(x => b.has(x));
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!deepEqual(a[key], b[key])) return false;
  return true;
};

/**
 * `effectiveX { get { x ?? X() } set { x = newValue } }`. Swift's `config.effectiveX.y = 1` reads, changes and writes
 * back; here the stored value is returned as is, and a default stands in that writes itself into `owner[key]` on its
 * first change, so `config.effectiveX.y = 1` keeps working while merely reading leaves `x` nil.
 */
export const effective = (owner, key, make) => {
  if (owner[key] !== undefined) return owner[key];
  const value = make();
  return new Proxy(value, {
    set(target, property, newValue) {
      if (owner[key] === undefined) owner[key] = target;
      return Reflect.set(target, property, newValue, target);
    }
  });
};

// ---- Foundation text ----------------------------------------------------------------------------------------

/** JSONSerialization.jsonObject(with:) as `[String: Any]`, or undefined (the `try? ... as? [String: Any]`). */
export const jsonObject = text => {
  try { const value = JSON.parse(text); return isObject(value) ? value : undefined; } catch { return undefined; }
};
/** JSONSerialization.data(withJSONObject:options:) as text; `sortedKeys` sorts every object's keys. */
export const serialize = (value, {sortedKeys = false} = {}) => {
  const sort = item => Array.isArray(item) ? item.map(sort) : isObject(item)
    ? Object.fromEntries(Object.keys(item).sort(compareKeys).map(key => [key, sort(item[key])])) : item;
  return escapeSlashes(JSON.stringify(sortedKeys ? sort(value) : value));
};
// Foundation sorts keys with [.numeric, .caseInsensitive, .forcedOrdering]; the keys written here are plain words.
const compareKeys = (a, b) => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};
/** Swift String comparison (`<`) by Unicode scalars. */
export const compareStrings = (a, b) => {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i].codePointAt(0), q = y[i].codePointAt(0);
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
};

// `value as? T` on what JSONSerialization returns.
export const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);
export const asString = v => typeof v === 'string' ? v : undefined;
/** `as? Int`: an integral number. */
export const asInt = v => typeof v === 'number' && Number.isInteger(v) ? v : undefined;
/** `as? Double`. */
export const asDouble = v => typeof v === 'number' ? v : undefined;
export const asBool = v => typeof v === 'boolean' ? v : undefined;
/** `as? NSNumber`: JSON booleans are NSNumbers too (true is 1). */
export const asNSNumber = v => typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : undefined;
/** NSNumber.intValue (truncates). */
export const nsIntValue = v => { const n = asNSNumber(v); return n === undefined ? undefined : Math.trunc(n); };
/** NSNumber.stringValue. */
export const nsStringValue = v => typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(v) : undefined;
export const asObject = v => isObject(v) ? v : undefined;
/** `as? [[String: Any]]`: every element must be an object. */
export const asObjects = v => Array.isArray(v) && v.every(isObject) ? v : undefined;
/** `as? [String]`. */
export const asStrings = v => Array.isArray(v) && v.every(x => typeof x === 'string') ? v : undefined;

// ---- Characters and CharacterSets ---------------------------------------------------------------------------

// Characters whose Unicode Numeric_Type is set although they are not \p{N} (the Unihan numerals): Swift's
// Character.isNumber is `numericType != nil` on the first scalar, so "一" counts as a number.
const hanNumerals = new Set([0x3405, 0x3483, 0x382A, 0x3B4D, 0x4E00, 0x4E03, 0x4E07, 0x4E09, 0x4E24, 0x4E5D, 0x4E8C, 0x4E94,
  0x4E96, 0x4EAC, 0x4EBF, 0x4EC0, 0x4EDF, 0x4EE8, 0x4F0D, 0x4F70, 0x4FE9, 0x5006, 0x5104, 0x5146, 0x5169, 0x516B, 0x516D, 0x5341,
  0x5343, 0x5344, 0x5345, 0x534C, 0x53C1, 0x53C2, 0x53C3, 0x53C4, 0x56DB, 0x58F1, 0x58F9, 0x5E7A, 0x5EFE, 0x5EFF, 0x5F0C, 0x5F0D,
  0x5F0E, 0x5F10, 0x62D0, 0x62FE, 0x634C, 0x67D2, 0x6D1E, 0x6F06, 0x7396, 0x767E, 0x7695, 0x79ED, 0x8086, 0x842C, 0x8CAE, 0x8CB3,
  0x8D30, 0x920E, 0x94A9, 0x9621, 0x9646, 0x964C, 0x9678, 0x96F6, 0xF96B, 0xF973, 0xF978, 0xF9B2, 0xF9D1, 0xF9D3, 0xF9FD, 0x20001,
  0x20064, 0x200E2, 0x20121, 0x2092A, 0x20983, 0x2098C, 0x2099C, 0x20AEA, 0x20AFD, 0x20B19, 0x22390, 0x22998, 0x23B1B, 0x2626D, 0x2F890]);
const first = character => String.fromCodePoint(character.codePointAt(0));
/** Character.isNumber. */
export const isNumber = character => !!character && (/\p{N}/u.test(first(character)) || hanNumerals.has(character.codePointAt(0)));
/** Character.isLetter (Alphabetic). */
export const isLetter = character => !!character && /\p{Alphabetic}/u.test(first(character));
/** Character.isWhitespace (White_Space). */
export const isWhitespace = character => !!character && /\p{White_Space}/u.test(first(character));
/** Character.isASCII ("\r\n" counts). */
export const isASCII = character => character === '\r\n' || /^[\x00-\x7f]$/.test(character);

// Scalar classes of Foundation's CharacterSets.
const newlineScalars = '\\n\\v\\f\\r\\u0085\\u2028\\u2029';
/** CharacterSet.whitespacesAndNewlines (Z*, tab, U+000A–U+000D, U+0085). */
export const WHITESPACES_AND_NEWLINES = `\\p{Z}\\t${newlineScalars}`;
/** CharacterSet.whitespaces (Zs and tab). */
export const WHITESPACES = '\\p{Zs}\\t';
const trimRegex = set => new RegExp(`^[${set}]+|[${set}]+$`, 'gu');
const trimAll = trimRegex(WHITESPACES_AND_NEWLINES), trimSpaces = trimRegex(WHITESPACES);
/** trimmingCharacters(in: .whitespacesAndNewlines). */
export const trimmed = value => String(value ?? '').replace(trimAll, '');
/** trimmingCharacters(in: .whitespaces). */
export const trimmedSpaces = value => String(value ?? '').replace(trimSpaces, '');
/** trimmingCharacters(in: CharacterSet(charactersIn: chars)). */
export const trimmedSet = (value, chars) => {
  const set = new Set(Array.from(chars));
  const scalars = Array.from(value);
  let start = 0, end = scalars.length;
  while (start < end && set.has(scalars[start])) start++;
  while (end > start && set.has(scalars[end - 1])) end--;
  return scalars.slice(start, end).join('');
};
/** CharacterSet.controlCharacters (Cc and Cf) anywhere in the text. */
export const hasControlCharacters = value => /[\p{Cc}\p{Cf}]/u.test(value);

/**
 * URL(string:) / URLComponents(string:) as far as the BotCore checks read them: scheme, user, password, host, port,
 * path (percent-decoded), query and fragment. Undefined for what Foundation would not parse (no scheme, spaces or
 * control characters, a non-numeric port).
 */
export const parseURL = string => {
  if (typeof string !== 'string' || /[\s\p{Cc}]/u.test(string)) return undefined;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/u.exec(string);
  if (!match) return undefined;
  const [, scheme, authority, rawPath, query, fragment] = match;
  const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
  let user, password, host, port;
  if (authority !== undefined) {
    const parts = /^(?:([^@]*)@)?(\[[^\]]*\]|[^:]*)(?::(.*))?$/u.exec(authority);
    if (!parts) return undefined;
    const [, userinfo, hostPart, portPart] = parts;
    if (userinfo !== undefined) {
      const colon = userinfo.indexOf(':');
      user = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
      if (colon >= 0) password = decode(userinfo.slice(colon + 1));
    }
    host = decode(hostPart.replace(/^\[|\]$/g, ''));
    if (portPart !== undefined && portPart !== '') {
      if (!/^\d+$/.test(portPart)) return undefined;
      port = Number(portPart);
    }
  }
  return {scheme, user, password, host, port, path: decode(rawPath), query, fragment};
};

// ---- ICU (NSRegularExpression) pieces -------------------------------------------------------------------------

/** ICU `\s`: [\t\n\f\r\p{Z}]; use inside a character class. */
export const ICU_SPACE = '\\t\\n\\f\\r\\p{Z}';
/** ICU `.` without dotAll: anything but a line terminator. */
export const ICU_DOT = `[^${newlineScalars}]`;
/** ICU `$` without multiline: the end, or just before a final line terminator. */
export const ICU_END = `(?=(?:\\r\\n|[${newlineScalars}])?$)`;
/** NSRegularExpression.escapedPattern(for:). */
export const escapePattern = value => value.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

// ---- Calendar -------------------------------------------------------------------------------------------------

/** TimeZone(identifier:) != nil. */
export const validTimeZone = identifier => {
  if (typeof identifier !== 'string' || !identifier) return false;
  try { new Intl.DateTimeFormat('en-US', {timeZone: identifier}); return true; } catch { return false; }
};
const formatters = new Map();
const fieldsOf = (date, timeZone) => {
  let format = formatters.get(timeZone ?? '');
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'});
    formatters.set(timeZone ?? '', format);
  }
  const out = {};
  for (const part of format.formatToParts(date)) if (part.type !== 'literal') out[part.type] = Number(part.value);
  if (out.hour === 24) out.hour = 0;
  return out;
};
/** Calendar(identifier: .gregorian) in one time zone; `Calendar.current` uses the process's local zone. */
export class Calendar {
  constructor(timeZone) { this.timeZone = timeZone; }
  static get current() { return new Calendar(); }
  /** dateComponents([.year, .month, .day, .hour, .minute, .second], from:). */
  dateComponents(date) { return fieldsOf(date, this.timeZone); }
  component(unit, date) { return fieldsOf(date, this.timeZone)[unit]; }
  /** Seconds east of UTC at that instant. */
  offset(date) {
    const f = fieldsOf(date, this.timeZone);
    const local = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    return (local - Math.floor(date.getTime() / 1000) * 1000) / 1000;
  }
  /** date(from: DateComponents(...)). */
  date({year, month = 1, day = 1, hour = 0, minute = 0, second = 0}) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, second);
    let time = guess - this.offset(new Date(guess)) * 1000;
    const again = guess - this.offset(new Date(time)) * 1000;
    if (again !== time) time = again;
    return new Date(time);
  }
  /** date(bySettingHour:minute:second:of:). */
  dateBySetting(hour, minute, second, date) {
    const f = fieldsOf(date, this.timeZone);
    return this.date({year: f.year, month: f.month, day: f.day, hour, minute, second});
  }
  startOfDay(date) { return this.dateBySetting(0, 0, 0, date); }
  /** dateInterval(of: .hour, for:)!.start. */
  startOfHour(date) {
    const f = fieldsOf(date, this.timeZone), ms = ((date.getTime() % 1000) + 1000) % 1000;
    return new Date(date.getTime() - ms - (f.minute * 60 + f.second) * 1000);
  }
  isDate(date, sameDayAs) {
    const a = fieldsOf(date, this.timeZone), b = fieldsOf(sameDayAs, this.timeZone);
    return a.year === b.year && a.month === b.month && a.day === b.day;
  }
}

export {graphemes};
