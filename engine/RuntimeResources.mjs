// Port of RuntimeResources.swift (the Linux branch): no Keychain, and the resources directory comes from
// DAFEIYU_RESOURCES or upstream/Resources (swift.mjs's resources()).
import {resources} from './swift.mjs';

export class RuntimeResources {
  static get supportsKeychain() { return false; }
  /** URL? → a path string. */
  static get directory() { return resources(); }
}
