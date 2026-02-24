import { Connection, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

// dotenv is a no-op when env vars are already set (e.g. in GitHub Actions)
dotenv.config();

const programId = new PublicKey(process.env.PROGRAM_ID!);
const connection = new Connection(process.env.RPC_URL!);
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

interface TxData {
  signature: string;
  blockTime?: number;
  slot: number;
}

async function main() {
  validateConfig();

  const programDataAddress = await getProgramDataAddress(connection, programId);
  if (!programDataAddress) {
    console.log(
      "⚠️  Program is not upgradeable (no ProgramData account found).",
    );
    console.log(
      "   IDL checks are not applicable for immutable programs via this method.",
    );
    process.exit(0);
  }
  const idlPda = await getIdlPda(programId);

  const [programUpgradeTx, idlUpgradeTx] = await Promise.all([
    getLatestUpgradeTransaction(programDataAddress.toBase58()),
    getLatestTransaction(idlPda.toBase58(), "IdlAccount"),
  ]);

  if (!programUpgradeTx) {
    console.error(
      "❌ No program upgrade transaction found for ProgramData (searched recent history).",
    );
    process.exit(1);
  }

  if (!idlUpgradeTx) {
    console.error("❌ IDL account has no history. Is it initialized?");
    process.exit(1);
  }

  printReport(
    programId.toBase58(),
    programDataAddress.toBase58(),
    idlPda.toBase58(),
    programUpgradeTx,
    idlUpgradeTx,
  );

  if (programUpgradeTx.slot > idlUpgradeTx.slot) {
    console.error("\n🚨 RESULT: OUTDATED");
    console.error("   The program was upgraded AFTER the last IDL update.");
    console.error("   Developers may be integrating against stale types.");
    console.error(
      `\n👉 ACTION: anchor idl upgrade ${programId.toBase58()} -f target/idl/<program>.json`,
    );
    process.exit(1);
  } else {
    console.log("\n✅ RESULT: OK");
    console.log(
      "   IDL is up-to-date or newer than the last program binary deployment.",
    );
    process.exit(0);
  }
}

function validateConfig() {
  const missing = [];
  if (!process.env.RPC_URL) missing.push("RPC_URL");
  if (!process.env.PROGRAM_ID) missing.push("PROGRAM_ID");

  if (missing.length > 0) {
    console.error("❌ Missing required inputs: " + missing.join(", "));
    process.exit(1);
  }
}

async function getProgramDataAddress(
  connection: Connection,
  programId: PublicKey,
): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(programId);
  if (!info) {
    throw new Error(`Program account ${programId} not found`);
  }

  if (!info.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)) {
    throw new Error(
      `Expected BPF loader, got: ${info.owner} for program ${programId}`,
    );
  }

  return new PublicKey(info.data.subarray(4, 36));
}

async function getIdlPda(programId: PublicKey): Promise<PublicKey> {
  const base = PublicKey.findProgramAddressSync([], programId)[0];
  const idlPda = await PublicKey.createWithSeed(base, "anchor:idl", programId);
  return idlPda;
}

async function getLatestTransaction(
  address: string,
  label: string,
): Promise<TxData | null> {
  try {
    const response = await fetch(process.env.RPC_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [
          address,
          {
            limit: 1,
          },
        ],
      }),
    });

    const data = await response.json();
    const txs = data.result as TxData[];

    if (!txs || txs.length === 0) {
      return null;
    }

    // Return the most recent one
    return txs[0];
  } catch (err: any) {
    console.error(`❌ Error fetching history for ${label}:`, err.message);
    throw err;
  }
}

/**
 * Finds the latest actual program upgrade transaction for a ProgramData account.
 * Walks backwards through transaction history, skipping non-upgrade txs
 * (e.g. SetAuthority which also touches the ProgramData account).
 *
 * BPF Loader Upgradeable instruction discriminators (little-endian u32):
 *   0 = InitializeBuffer
 *   1 = Write
 *   2 = DeployWithMaxDataLen
 *   3 = Upgrade
 *   4 = SetAuthority
 *   5 = Close
 *   6 = ExtendProgram
 *   7 = SetAuthorityChecked
 */
const UPGRADE_DISCRIMINATOR = 3;
const BATCH_SIZE = 10;
const MAX_BATCHES = 10;

async function getLatestUpgradeTransaction(
  programDataAddress: string,
): Promise<TxData | null> {
  let before: string | undefined;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const sigsResponse = await fetch(process.env.RPC_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [
          programDataAddress,
          {
            limit: BATCH_SIZE,
            ...(before ? { before } : {}),
          },
        ],
      }),
    });

    const sigsData = await sigsResponse.json();
    const sigs = sigsData.result as TxData[];

    if (!sigs || sigs.length === 0) {
      return null;
    }

    // Fetch full transaction details for this batch
    for (const sig of sigs) {
      const txResponse = await fetch(process.env.RPC_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            sig.signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ],
        }),
      });

      const txData = await txResponse.json();
      const tx = txData.result;

      if (!tx || !tx.transaction) continue;

      if (isUpgradeInstruction(tx)) {
        return sig;
      }
    }

    before = sigs[sigs.length - 1].signature;
  }

  return null;
}

function isUpgradeInstruction(tx: any): boolean {
  const message = tx.transaction.message;
  const instructions = message.instructions ?? [];
  const innerInstructions = tx.meta?.innerInstructions ?? [];

  // Check top-level and inner instructions
  const allInstructions = [
    ...instructions,
    ...innerInstructions.flatMap((ix: any) => ix.instructions ?? []),
  ];

  for (const ix of allInstructions) {
    // jsonParsed: parsed BPF Loader Upgradeable instructions
    if (
      ix.program === "bpf-upgradeable-loader" &&
      ix.parsed?.type === "upgrade"
    ) {
      return true;
    }

    // Fallback: raw instruction data against BPF Loader Upgradeable program
    if (
      ix.programId === BPF_LOADER_UPGRADEABLE_PROGRAM_ID.toBase58() &&
      ix.data
    ) {
      try {
        const decoded = Buffer.from(ix.data, "base64");
        if (decoded.length >= 4 && decoded.readUInt32LE(0) === UPGRADE_DISCRIMINATOR) {
          return true;
        }
      } catch {
        // not base64, skip
      }
    }
  }

  return false;
}

function printReport(
  programId: string,
  programData: string,
  idlAccount: string,
  programUpgradeTx: TxData | null,
  idlUpgradeTx: TxData | null,
) {
  console.log("📊 STATUS REPORT");
  console.log("================");
  console.log(`Program ID:       ${programId}`);
  console.log(`ProgramData:      ${programData}`);
  console.log(`Idl Account:      ${idlAccount}`);
  console.log("----------------");

  console.log("Latest Program Upgrade:");
  if (programUpgradeTx) {
    console.log(`  Slot:      ${programUpgradeTx.slot}`);
    console.log(`  Block Time: ${programUpgradeTx.blockTime}`);
    console.log(`  Signature: ${programUpgradeTx.signature}`);
  } else {
    console.log("  [No Data]");
  }

  console.log("\nLatest IDL Upgrade:");
  if (idlUpgradeTx) {
    console.log(`  Slot:      ${idlUpgradeTx.slot}`);
    console.log(`  Block Time: ${idlUpgradeTx.blockTime}`);
    console.log(`  Signature: ${idlUpgradeTx.signature}`);
  } else {
    console.log("  [No Data]");
  }
  console.log("================");
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
