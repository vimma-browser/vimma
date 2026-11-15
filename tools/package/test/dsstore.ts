// A reader for the records of a Finder .DS_Store file, enough for the tests to check the dmg's
// committed `dsstore` (spec macos-homebrew, decision 14). The format is a buddy allocator holding
// one B-tree, "DSDB", whose records are (file name, four-letter code, typed value); it is
// described at https://metacpan.org/dist/Mac-Finder-DSStore/view/DSStoreFormat.pod.

/**
 * @typedef {{ name: string, code: string, type: string, value: Buffer | number | string }} DsRecord
 */

/**
 * Every record of a .DS_Store, in file order. A `blob` value is returned as its bytes, so a
 * caller reads an `Iloc` position or searches a property list itself.
 * @param {Buffer} file
 * @returns {DsRecord[]}
 */
export function readDsStore(file) {
  if (file.readUInt32BE(0) !== 1 || file.toString("latin1", 4, 8) !== "Bud1") {
    throw new Error("not a .DS_Store: no Bud1 header");
  }
  // Offsets in the allocator are relative to the byte after the leading 1.
  const buf = file.subarray(4);
  const rootOffset = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(rootOffset);
  /** @type {number[]} */
  const addresses = [];
  for (let i = 0; i < count; i++) addresses.push(buf.readUInt32BE(rootOffset + 8 + 4 * i));
  let p = rootOffset + 8 + 4 * Math.ceil(count / 256) * 256;
  const dirs = new Map();
  const ndirs = buf.readUInt32BE(p);
  p += 4;
  for (let i = 0; i < ndirs; i++) {
    const length = buf[p] ?? 0;
    const name = buf.toString("latin1", p + 1, p + 1 + length);
    p += 1 + length;
    dirs.set(name, buf.readUInt32BE(p));
    p += 4;
  }
  /** @param {number} id */
  const block = (id) => {
    const address = addresses[id] ?? 0;
    const offset = address & ~0x1f;
    return buf.subarray(offset, offset + 2 ** (address & 0x1f));
  };
  if (!dirs.has("DSDB")) throw new Error("not a .DS_Store: no DSDB tree");
  const rootNode = block(dirs.get("DSDB")).readUInt32BE(0);
  /** @type {DsRecord[]} */
  const records = [];
  /** @param {number} id */
  const walk = (id) => {
    const node = block(id);
    const right = node.readUInt32BE(0);
    const n = node.readUInt32BE(4);
    let q = 8;
    for (let i = 0; i < n; i++) {
      if (right) {
        walk(node.readUInt32BE(q));
        q += 4;
      }
      const length = node.readUInt32BE(q);
      q += 4;
      // swap16 works in place, so on a copy
      const name = Buffer.from(node.subarray(q, q + 2 * length))
        .swap16()
        .toString("utf16le");
      q += 2 * length;
      const code = node.toString("latin1", q, q + 4);
      const type = node.toString("latin1", q + 4, q + 8);
      q += 8;
      /** @type {Buffer | number | string} */
      let value;
      if (type === "blob") {
        const size = node.readUInt32BE(q);
        value = Buffer.from(node.subarray(q + 4, q + 4 + size));
        q += 4 + size;
      } else if (type === "long" || type === "shor") {
        value = node.readUInt32BE(q);
        q += 4;
      } else if (type === "bool") {
        value = node[q] ?? 0;
        q += 1;
      } else if (type === "type") {
        value = node.toString("latin1", q, q + 4);
        q += 4;
      } else if (type === "ustr") {
        const size = node.readUInt32BE(q);
        value = Buffer.from(node.subarray(q + 4, q + 4 + 2 * size))
          .swap16()
          .toString("utf16le");
        q += 4 + 2 * size;
      } else {
        throw new Error(`unknown .DS_Store record type ${type}`);
      }
      records.push({ name, code, type, value });
    }
    if (right) walk(right);
  };
  walk(rootNode);
  return records;
}
