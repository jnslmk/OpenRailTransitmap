/**
 * Which operators are drawn, and how that survives a link.
 *
 * The mode legend can carry its filter as "the modes that are on", because
 * there are six of them and every one has a row. Operators are a different
 * shape: getting on for three hundred companies run something in the data and
 * a dozen or so are in view at a time, so a reader who switches one off cannot
 * be made to carry the other two hundred and ninety in the URL.
 *
 * The filter therefore has a polarity. `names` is either the only operators
 * drawn or the only ones left out, which keeps both "everything except this
 * one" and "just these two" down to a handful of characters, and lets the
 * panel start from all-on without ever having to enumerate all-on.
 */

import type { ExpressionSpecification } from 'maplibre-gl';

export interface OperatorFilter {
  /** true: only `names` is drawn. false: everything but `names` is drawn. */
  only: boolean;
  names: Set<string>;
}

/** The default: no operator filter at all. */
export const allOperators = (): OperatorFilter => ({ only: false, names: new Set() });

/** The master switch turned off: an empty allow-list draws nothing. */
export const noOperators = (): OperatorFilter => ({ only: true, names: new Set() });

export const drawsEveryOperator = (f: OperatorFilter) => !f.only && f.names.size === 0;
export const drawsNoOperator = (f: OperatorFilter) => f.only && f.names.size === 0;

/** Whether this operator's lines are drawn. A line with no operator is `''`. */
export function operatorShown(f: OperatorFilter, operator: string): boolean {
  return f.only ? f.names.has(operator) : !f.names.has(operator);
}

/**
 * One operator switched on or off, whichever way round the filter is stated.
 * A new filter rather than a mutation, so a caller can compare before and
 * after - the sidebar does, to decide whether a selection has just been
 * filtered off the map.
 */
export function withOperator(f: OperatorFilter, operator: string, on: boolean): OperatorFilter {
  const names = new Set(f.names);
  // In an allow-list, "on" means listed; in a deny-list it means not listed.
  if (on === f.only) names.add(operator); else names.delete(operator);
  return { only: f.only, names };
}

/**
 * `~` rather than the comma the mode list uses: one operator in the data is
 * registered as `Ilztalbahn GmbH, Färbergasse 1, 94065 Waldkirchen`, and a
 * separator that occurs inside a name is a link that comes back wrong. It is
 * the same character `encodePlace` picked for the same reason.
 */
const SEP = '~';

const split = (raw: string): Set<string> =>
  new Set(raw.split(SEP).map((s) => s.trim()).filter(Boolean));

/**
 * Read the filter off a query string.
 *
 * `op` is the allow-list and `opoff` the deny-list; neither present means every
 * operator. `op` present but empty is the honest encoding of "none of them" -
 * an allow-list with nothing on it - which is why presence is tested rather
 * than truthiness. A link from the old single-select filter (`?op=DB%20Regio`)
 * parses as an allow-list of one, which is what it always meant.
 */
export function readOperators(q: URLSearchParams): OperatorFilter {
  const only = q.get('op');
  if (only !== null) return { only: true, names: split(only) };
  const except = q.get('opoff');
  if (except !== null) return { only: false, names: split(except) };
  return allOperators();
}

/** The inverse, writing nothing at all when nothing is filtered. */
export function writeOperators(q: URLSearchParams, f: OperatorFilter): void {
  if (drawsEveryOperator(f)) return;
  q.set(f.only ? 'op' : 'opoff', [...f.names].join(SEP));
}

/**
 * A signature of the filter, for the "has anything changed" guards. Sorted, so
 * that two filters naming the same operators compare equal whatever order the
 * reader clicked them in.
 */
export const operatorKey = (f: OperatorFilter): string =>
  `${f.only ? '=' : '!'}${[...f.names].sort().join(SEP)}`;

/**
 * The operator half of the route filter, or null when there is nothing to
 * filter and the mode clause can stand alone.
 *
 * `to-string` rather than a bare `get`: a route without the property evaluates
 * to null, and `in` on a null needle is a runtime error, which in MapLibre
 * means a warning on the console and a layer that paints nothing at all.
 */
export function operatorExpression(f: OperatorFilter): ExpressionSpecification | null {
  if (drawsEveryOperator(f)) return null;
  const named: ExpressionSpecification =
    ['in', ['to-string', ['get', 'operator']], ['literal', [...f.names]]];
  return f.only ? named : ['!', named];
}
