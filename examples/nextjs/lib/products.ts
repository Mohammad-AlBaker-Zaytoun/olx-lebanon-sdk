// lib/products.ts: your products, and how one becomes an OLX ad.
import 'server-only';
import type { AdInput } from 'olx-lebanon-sdk';

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  brand: 'Dell' | 'HP' | 'Lenovo';
  condition: 'new' | 'used';
  imageUrls: string[];
}

/** Replace with your database query. */
export async function getProduct(id: string): Promise<Product | undefined> {
  return id === 'demo'
    ? {
        id,
        name: 'Dell Latitude 5440',
        description: '16 GB RAM, 512 GB SSD, 1 year warranty.',
        price: 899,
        brand: 'Dell',
        condition: 'new',
        imageUrls: ['https://shop.example.com/images/dell-5440.jpg'],
      }
    : undefined;
}

// OLX's choice values for category 175 (Laptops, Tablets, Computers), from `npx olx-lb catalog fields 175`.
const MAKE = { Dell: '3', HP: '4', Lenovo: '6' } as const;
const CONDITION = { new: '1', used: '2' } as const;

export function toAdInput(p: Product): AdInput {
  return {
    title: p.name.slice(0, 70),
    description: p.description,
    price: p.price,
    categoryId: '175',
    locationId: '47', // Beirut > Hamra: where buyers see the item
    attributes: { make: MAKE[p.brand], type: '1', new_used: CONDITION[p.condition] },
    images: p.imageUrls.map((url) => ({ url })),
  };
}
