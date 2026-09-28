import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requirePermission } from "@/lib/auth";
import { listExpenseCategories, listProductCategories } from "@/lib/categories";
import { bpText } from "@/lib/num";
import { saveExpenseCategoryAction, saveProductCategoryAction } from "./actions";
import { ExpenseCategories, ProductCategories } from "./categories-tables";

export default async function CategoriesPage() {
  await requirePermission("categories", "view");
  const [products, expenses] = await Promise.all([listProductCategories(), listExpenseCategories()]);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Categories"
        description="Product categories for quotation and invoice lines; expense categories for bills and expenses."
      />
      <Tabs defaultValue="products" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="products">Products & services ({products.length})</TabsTrigger>
          <TabsTrigger value="expenses">Expenses ({expenses.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="products">
          <ProductCategories
            rows={products.map((p) => ({
              id: p.id,
              name: p.name,
              hsnSac: p.hsnSac ?? "",
              gstPercent: bpText(p.gstBp),
              active: p.active,
            }))}
            action={saveProductCategoryAction}
          />
        </TabsContent>
        <TabsContent value="expenses">
          <ExpenseCategories
            rows={expenses.map((e) => ({
              id: e.id,
              name: e.name,
              accountCode: e.accountCode,
              costBucket: e.costBucket,
              active: e.active,
            }))}
            action={saveExpenseCategoryAction}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
