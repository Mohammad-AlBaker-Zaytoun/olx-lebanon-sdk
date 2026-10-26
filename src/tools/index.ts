/**
 * Tools for mapping OLX's wire format from a capture of the web app, when OLX changes it:
 * `import { summarizeHar, buildShapeReport } from 'olx-lebanon-sdk/tools'`.
 */
export {
  formatHarSummary,
  formatHostActivity,
  isSensitiveSegment,
  summarizeHar,
  tallyHosts,
  type HarCall,
  type HostActivity,
} from './har.js';
export {
  OLX_LB_CATALOG_API,
  catalogEntry,
  categoryLabel,
  describeFields,
  listCategories,
  postableFields,
  type OlxCategoryNode,
  type OlxField,
  type OlxFieldChoice,
} from './catalogFields.js';
export {
  buildShapeReport,
  describeAuthorization,
  idPattern,
  parseJsonish,
  shapeOf,
  type HarFull,
  type ShapeOptions,
} from './harShapes.js';
