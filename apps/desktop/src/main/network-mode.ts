import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";

import { z } from "zod";

import { syncDirectory } from "./filesystem-durability.ts";

export async function openNetworkMode(stateRoot: string) {
  await mkdir(stateRoot, { recursive: true });
  const path = join(stateRoot, "network-mode.json");
  let offline = false;
  try {
    offline = z
      .strictObject({ offline: z.boolean() })
      .parse(JSON.parse(await readFile(path, "utf8"))).offline;
  } catch (error) {
    offline = !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
  return new NetworkMode(path, offline);
}

export class NetworkMode {
  #offline: boolean;
  readonly #path: string;
  readonly #listeners = new Set<() => void>();
  #write: Promise<void> = Promise.resolve();
  #pending = 0;
  constructor(path: string, offline: boolean) {
    this.#path = path;
    this.#offline = offline;
  }
  get offline() {
    return this.#offline;
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  async setOffline(offline: boolean) {
    if (this.#pending >= 32) throw new Error("Network settings are busy");
    this.#pending++;
    this.#offline = offline;
    for (const listener of this.#listeners) listener();
    this.#write = this.#write.catch(() => {}).then(() => persistNetworkMode(this.#path, offline));
    try {
      await this.#write;
    } finally {
      this.#pending--;
    }
  }
}

async function persistNetworkMode(path: string, offline: boolean) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ offline }));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temp, { force: true });
  }
}
