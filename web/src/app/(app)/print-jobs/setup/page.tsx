import { asc, eq } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { db } from "@/db";
import { productCategories } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { moneyText } from "@/lib/num";
import { canViewCost } from "@/lib/permissions";
import { listMachines, listPrintingTypes } from "@/lib/print-jobs";
import { saveMachineAction, savePrintingTypeAction } from "../actions";
import { Machines, PrintingTypes } from "./setup-tables";

/** Print masters (owner / accountant): machines (cost rates only with can_view_cost) and printing types. */
export default async function PrintSetupPage() {
  const user = await requirePermission("printJobs", "edit");
  const [machines, types, categories] = await Promise.all([
    listMachines(user),
    listPrintingTypes(),
    db.select({ id: productCategories.id, name: productCategories.name }).from(productCategories).where(eq(productCategories.active, true)).orderBy(asc(productCategories.id)),
  ]);
  const cost = canViewCost(user);
  const rate = (paise: bigint | null | undefined) => (paise == null ? "" : moneyText(paise));

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader back={{ href: "/print-jobs", label: "Print jobs" }} title="Machines & printing types" />
      <Tabs defaultValue="machines" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="machines">Machines ({machines.length})</TabsTrigger>
          <TabsTrigger value="types">Printing types ({types.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="machines">
          <Machines
            cost={cost}
            rows={machines.map((m) => ({
              id: m.id,
              name: m.name,
              printers: m.printerNames,
              saleRate: rate(m.saleRatePaise),
              ...(cost ? { costRate: rate(m.costRatePaise) } : {}),
              active: m.active,
            }))}
            action={saveMachineAction}
          />
        </TabsContent>
        <TabsContent value="types">
          <PrintingTypes
            rows={types.map((t) => ({ id: t.id, name: t.name, categoryId: t.categoryId ? String(t.categoryId) : "", category: t.category ?? "", active: t.active }))}
            categories={categories}
            action={savePrintingTypeAction}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
