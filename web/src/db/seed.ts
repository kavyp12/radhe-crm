// `pnpm db:seed` entry. T09 adds master-data seeds here.
import { db } from "@/db";
import { seedOwner } from "@/lib/users";

async function main() {
  const { OWNER_USERNAME: username, OWNER_PASSWORD: password, OWNER_NAME: name } = process.env;
  if (!username || !password || !name) throw new Error("Set OWNER_USERNAME, OWNER_PASSWORD and OWNER_NAME in web/.env");
  const result = await seedOwner({ username, password, name });
  console.log(result === "created" ? `Owner "${username}" created.` : "An owner already exists; nothing to seed.");
}

main().finally(() => db.$client.end());
