import { OlxCatalog, type CategoryField } from '../../catalog/OlxCatalog.js';
import type { Command } from '../index.js';
import { UsageError, parseFlags, table } from '../util.js';

/** A starting entry for config/catalog.json: required fields and every choice, by label. */
export function catalogEntryFor(categoryId: string, label: string, fields: CategoryField[]): Record<string, unknown> {
  const own = fields.filter((f) => !f.filledFromPrice);
  const price = fields.find((f) => f.attribute === 'price');
  return {
    label,
    olxCategoryId: categoryId,
    requiredAttributes: own.filter((f) => f.required).map((f) => f.attribute),
    attributeMap: {},
    valueMap: Object.fromEntries(
      own.filter((f) => f.choices.length).map((f) => [f.attribute, Object.fromEntries(f.choices.map((c) => [c.label, c.value]))]),
    ),
    defaults: {},
    ...(price && (price.min !== undefined || price.max !== undefined)
      ? { priceLimits: { ...(price.min !== undefined ? { min: price.min } : {}), ...(price.max !== undefined ? { max: price.max } : {}) } }
      : {}),
  };
}

export const catalog: Command = {
  summary: "Look up OLX's categories, a category's fields, and locations (public data, no login)",
  usage: `Usage:
  olx-lb catalog categories [text]      category ids (only those you can post in)
  olx-lb catalog fields <id> [<id>...]  the posting form's fields and their choices
  olx-lb catalog locations [text]       area ids (ads need an area, not a district)

Options:
  --json   print JSON instead of a table (for scripts)

Use the ids as categoryId / locationId, and the field names and choice values in
\`attributes\`. \`fields\` also prints a starting entry for config/catalog.json.`,

  async run(args, ctx) {
    const { flags, positionals } = parseFlags(args, { json: 'boolean' });
    const [what, ...rest] = positionals;
    const api = new OlxCatalog();
    const json = flags.json === true;

    if (what === 'categories') {
      const found = await api.findCategories(rest.join(' ') || undefined);
      if (json) return void ctx.out(JSON.stringify(found.map(({ id, name, path }) => ({ id, name, path })), null, 2));
      if (!found.length) return void ctx.out('No category matches that text.');
      ctx.out(table([['id', 'category'], ...found.map((c) => [c.id, c.path.join(' > ')])]).join('\n'));
      return;
    }

    if (what === 'fields') {
      if (!rest.length) throw new UsageError('Give at least one category id');
      const out: Record<string, unknown> = {};
      for (const id of rest) {
        const [fields, cat] = await Promise.all([api.fields(id), api.category(id)]);
        const label = cat?.path.join(' > ') ?? `category ${id}`;
        if (json) {
          out[id] = { category: label, fields };
          continue;
        }
        ctx.out(`${'='.repeat(80)}\n${label}  (categoryId ${id})\n`);
        for (const f of fields) {
          const limits = [
            f.min !== undefined ? `min ${f.min}` : '',
            f.max !== undefined ? `max ${f.max}` : '',
            f.maxLength !== undefined ? `max length ${f.maxLength}` : '',
          ].filter(Boolean);
          ctx.out(
            `${f.required ? 'REQUIRED' : 'optional'}  ${f.attribute}  [${f.type}]  "${f.label}"${limits.length ? '  ' + limits.join(', ') : ''}${f.filledFromPrice ? '  (filled from the price)' : ''}`,
          );
          for (const c of f.choices) ctx.out(`            ${JSON.stringify(c.value)} = ${c.label}`);
        }
        ctx.out('\nStarting entry for config/catalog.json "categories" (rename the key):\n');
        ctx.out(JSON.stringify({ 'your-category-key': catalogEntryFor(id, label, fields) }, null, 2));
      }
      if (json) ctx.out(JSON.stringify(out, null, 2));
      return;
    }

    if (what === 'locations') {
      const found = api.locations(rest.join(' ') || undefined);
      if (json) return void ctx.out(JSON.stringify(found, null, 2));
      if (!found.length) return void ctx.out('No area matches that text.');
      ctx.out(table([['id', 'location'], ...found.map((l) => [l.id, l.path.join(' > ')])]).join('\n'));
      ctx.out(`\n(${found.length} ${found.length === 1 ? "area" : "areas"}; snapshot from ${api.locationsTakenAt})`);
      return;
    }

    throw new UsageError(what ? `Unknown catalog lookup "${what}"` : 'Say what to look up');
  },
};
