#!/usr/bin/env node
// 成员令牌：文件里只存 sha256，令牌本身只在创建时显示一次。
// 用法：node server/members.mjs add <名字> | list | remove <名字>
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const membersFile = () => process.env.CO_MEMBERS || join(here, "data", "members.json");
const sha = (s) => createHash("sha256").update(s).digest("hex");

export function readMembers(file = membersFile()) {
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")).members ?? [];
}

function writeMembers(members, file = membersFile()) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ members }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** 按令牌找成员；用定长比较，避免按耗时猜令牌 */
export function memberByToken(token, members) {
  if (typeof token !== "string" || token.length < 20) return null;
  const h = Buffer.from(sha(token), "hex");
  for (const m of members) {
    const mh = Buffer.from(m.tokenSha256, "hex");
    if (mh.length === h.length && timingSafeEqual(mh, h)) return m;
  }
  return null;
}

export function addMember(name, file = membersFile()) {
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) throw new Error("名字只能用字母、数字、汉字、下划线和连字符，最长 32 个字");
  const members = readMembers(file);
  if (members.some((m) => m.name === name)) throw new Error(`已有成员：${name}`);
  const token = randomBytes(24).toString("base64url");
  members.push({ name, tokenSha256: sha(token), createdAt: new Date().toISOString() });
  writeMembers(members, file);
  return token;
}

export function removeMember(name, file = membersFile()) {
  const members = readMembers(file);
  const left = members.filter((m) => m.name !== name);
  if (left.length === members.length) throw new Error(`没有这个成员：${name}`);
  writeMembers(left, file);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, name] = process.argv.slice(2);
  try {
    if (cmd === "add" && name) {
      const token = addMember(name);
      console.log(`已添加成员 ${name}。令牌只显示这一次，请让对方保存好：\n\n  ${token}\n`);
    } else if (cmd === "remove" && name) {
      removeMember(name);
      console.log(`已删除成员 ${name}，他的令牌立即失效。`);
    } else if (cmd === "list") {
      for (const m of readMembers()) console.log(`${m.name}\t${m.createdAt}`);
    } else {
      console.log("用法：node server/members.mjs add <名字> | list | remove <名字>");
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
