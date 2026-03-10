import { NextResponse } from "next/server";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "avalanche.log");

async function ensureLogDir() {
  await mkdir(LOG_DIR, { recursive: true });
}

export async function POST(req: Request) {
  try {
    const { entries } = (await req.json()) as { entries: string[] };
    if (!entries?.length) {
      return NextResponse.json({ ok: true });
    }

    await ensureLogDir();

    for (const entry of entries) {
      // Log to server terminal (visible in npm run dev)
      console.log(entry);
      // Append to file
      await appendFile(LOG_FILE, entry + "\n", "utf-8");
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Log API error:", err);
    return NextResponse.json({ error: "Failed to write log" }, { status: 500 });
  }
}
