"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, requireUser } from "@/lib/auth";
import { search, type SearchGroup } from "@/lib/search";

export async function logout() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/login");
}

/** Universal search (T35): search() keeps to the areas this user may view. */
export async function searchAction(query: string): Promise<SearchGroup[]> {
  const user = await requireUser();
  return search(user, String(query));
}
