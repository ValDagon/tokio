/**
 * GET /api/categories — категории задач с подкатегориями.
 *
 * Паритет с `backend/app/api/routes.py::get_categories`:
 *  - перед чтением идемпотентно создаются системные категории
 *    (`ensure_user_and_categories` upstream → `ensureUser` + `ensureSystemCategories`);
 *  - `ORDER BY position, name` для категорий и подкатегорий (DAL сортирует
 *    `position, id`, поэтому пересортировываем в памяти по имени);
 *  - `CategorySchema` включает `color` и `position`, а `SubcategorySchema` —
 *    `category_id` и `position` (таблица в T16-спеке их опускает; routes.py
 *    главнее);
 *  - id отдаются строками (платформенные id числовые, upstream — UUID).
 */

import { requireUserId, type EndpointCtx } from '../lib/auth.js';
import {
  ensureSystemCategories,
  listCategories,
  listSubcategories,
} from '../lib/dal/tasks.js';
import { ensureUser } from '../lib/dal/users.js';

const byPositionThenName = <T extends { position: number; name: string }>(a: T, b: T): number =>
  a.position - b.position || a.name.localeCompare(b.name, 'ru');

export default async function (
  input: Record<string, unknown>,
  ctx?: EndpointCtx,
): Promise<unknown> {
  const userId = requireUserId(input, ctx);

  await ensureUser(userId);
  await ensureSystemCategories(userId);

  const categories = await listCategories(userId);
  const subcategoriesByCategory = await Promise.all(
    categories.map((category) => listSubcategories(userId, category.id)),
  );

  return categories.map((category, index) => ({
    id: String(category.id),
    name: category.name,
    color: category.color ?? null,
    position: category.position,
    subcategories: [...(subcategoriesByCategory[index] ?? [])]
      .sort(byPositionThenName)
      .map((subcategory) => ({
        id: String(subcategory.id),
        category_id: String(subcategory.categoryId),
        name: subcategory.name,
        position: subcategory.position,
      })),
  })).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'ru'));
}
