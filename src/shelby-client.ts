import { ShelbyNodeClient } from "@shelby-protocol/sdk/node";
import { Account, Ed25519PrivateKey, Network } from "@aptos-labs/ts-sdk";
import "dotenv/config";

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function resolveNetwork(): Network {
  const n = (process.env.APTOS_NETWORK ?? "testnet").toLowerCase();
  if (n === "shelbynet") return Network.SHELBYNET;
  if (n === "local")     return Network.LOCAL;
  return Network.TESTNET;
}

export const shelbyAccount = Account.fromPrivateKey({
  privateKey: new Ed25519PrivateKey(env("APTOS_PRIVATE_KEY")),
});

export const shelbyClient = new ShelbyNodeClient({
  network: resolveNetwork(),
  apiKey: env("SHELBY_API_KEY"),
});

export const SHELBY_RPC_URL = env("SHELBY_RPC_URL");
export const BLOB_ACCOUNT   = shelbyAccount.accountAddress.toString();