import { sb } from "./db.server";

type ProductCategory = "iOS" | "Android";

export interface CatalogProduct {
  id: string;
  name: string;
  category: ProductCategory;
  active: boolean;
  sort_order: number;
}

export interface CatalogPrice {
  id: string;
  product_id: string;
  duration_label: string;
  duration_days: number;
  price_usd: number;
  active: boolean;
  sort_order: number;
}

export interface VisibleCatalogPrice extends CatalogPrice {
  available_stock: number;
}

export interface VisibleCatalogProduct extends CatalogProduct {
  prices: VisibleCatalogPrice[];
  total_stock: number;
}

const CATEGORY_ORDER: ProductCategory[] = ["iOS", "Android"];

export async function getHideOutOfStockSetting() {
  const { data } = await sb
    .from("telegram_bot_settings")
    .select("hide_out_of_stock")
    .eq("singleton", true)
    .maybeSingle();

  return data?.hide_out_of_stock ?? false;
}

export async function getStockByPriceId() {
  const { data } = await sb
    .from("product_stock_keys")
    .select("price_id")
    .eq("used", false);

  const stockByPriceId = new Map<string, number>();
  for (const row of data ?? []) {
    stockByPriceId.set(row.price_id, (stockByPriceId.get(row.price_id) ?? 0) + 1);
  }

  return stockByPriceId;
}

export async function getVisibleCatalog() {
  const [hideOutOfStock, stockByPriceId, productsRes, pricesRes] = await Promise.all([
    getHideOutOfStockSetting(),
    getStockByPriceId(),
    sb.from("products").select("id, name, category, active, sort_order").eq("active", true).order("sort_order"),
    sb
      .from("product_prices")
      .select("id, product_id, duration_label, duration_days, price_usd, active, sort_order")
      .eq("active", true)
      .order("sort_order"),
  ]);

  const products = (productsRes.data ?? []) as CatalogProduct[];
  const prices = (pricesRes.data ?? []) as CatalogPrice[];

  const pricesByProduct = new Map<string, VisibleCatalogPrice[]>();
  for (const price of prices) {
    const available_stock = stockByPriceId.get(price.id) ?? 0;
    if (hideOutOfStock && available_stock <= 0) continue;

    const group = pricesByProduct.get(price.product_id) ?? [];
    group.push({ ...price, available_stock });
    pricesByProduct.set(price.product_id, group);
  }

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    products: products
      .filter((product) => product.category === category)
      .map((product) => {
        const visiblePrices = pricesByProduct.get(product.id) ?? [];
        return {
          ...product,
          prices: visiblePrices,
          total_stock: visiblePrices.reduce((sum, price) => sum + price.available_stock, 0),
        } satisfies VisibleCatalogProduct;
      })
      .filter((product) => (hideOutOfStock ? product.total_stock > 0 : true)),
  })).filter((section) => section.products.length > 0);

  return { grouped, hideOutOfStock, stockByPriceId };
}