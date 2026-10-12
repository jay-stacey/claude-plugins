// One place that binds htm to Preact and re-exports the hooks.
import { h, Fragment, render } from '../vendor/preact.module.js';
import htm from '../vendor/htm.module.js';

export const html = htm.bind(h);
export { h, Fragment, render };
export {
  useState, useEffect, useMemo, useRef, useCallback, useReducer, useLayoutEffect, useId,
} from '../vendor/hooks.module.js';
