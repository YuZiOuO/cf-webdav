import type { IfCondition, IfHeader, IfList } from "./types";
import type { Path, EntityTag } from "../core/types";
import { HTTPException } from "hono/http-exception";
import { decodePath } from "../../path";

export type { EntityTag } from "../core/types";
export { newETag } from "../core/etag";

const invalidIf = () =>
  new HTTPException(400, { message: "Invalid If header" });

interface IfMatchContext {
  etag?: EntityTag;
  lockTokens: ReadonlySet<string>;
}

export const parseIfHeader = (header: string): IfHeader => {
  const value = header.trim();
  if (!value) return [];

  let index = 0;
  const lists: IfList[] = [];
  const skipSpace = () => {
    while (index < value.length && /\s/.test(value[index])) index += 1;
  };
  const parseTag = () => {
    const start = index;
    index += 1;
    while (index < value.length && value[index] !== ">") index += 1;
    if (index === value.length) throw invalidIf();
    const token = value.slice(start + 1, index);
    index += 1;
    return token;
  };
  const parseEtag = (): EntityTag => {
    const start = index + 1;
    index += 1;
    while (index < value.length && value[index] !== "]") index += 1;
    if (index === value.length) throw invalidIf();
    const etag = value.slice(start, index);
    index += 1;
    if (!/^(?:W\/)?"/.test(etag) || !etag.endsWith('"')) throw invalidIf();
    return etag as EntityTag;
  };
  const parseCondition = (): IfCondition => {
    skipSpace();
    let not = false;
    if (
      value.slice(index, index + 3).toLowerCase() === "not" &&
      (index + 3 === value.length || /\s/.test(value[index + 3]))
    ) {
      not = true;
      index += 3;
      skipSpace();
    }
    if (value[index] === "<")
      return {
        kind: "state-token",
        token: parseTag(),
        ...(not ? { not } : {}),
      };
    if (value[index] === "[")
      return {
        kind: "entity-tag",
        etag: parseEtag(),
        ...(not ? { not } : {}),
      };
    throw invalidIf();
  };
  const parseList = (resource?: Path): IfList => {
    skipSpace();
    if (value[index] !== "(") throw invalidIf();
    index += 1;
    const conditions: IfCondition[] = [];
    while (true) {
      skipSpace();
      if (value[index] === ")") {
        index += 1;
        break;
      }
      if (index >= value.length) throw invalidIf();
      conditions.push(parseCondition());
    }
    if (!conditions.length) throw invalidIf();
    return { ...(resource ? { resource } : {}), conditions };
  };
  const parseResource = (): Path => {
    const tag = parseTag();
    try {
      const pathname = tag.startsWith("/") ? tag : new URL(tag).pathname;
      return decodePath(pathname);
    } catch {
      throw invalidIf();
    }
  };

  if (value[index] === "<") {
    while (index < value.length) {
      const resource = parseResource();
      do {
        lists.push(parseList(resource));
        skipSpace();
      } while (index < value.length && value[index] === "(");
    }
  } else {
    while (index < value.length) {
      lists.push(parseList());
    }
  }
  return lists;
};

export const ifHeaderMatches = async (
  header: IfHeader,
  requestPath: Path,
  contextFor: (path: Path) => Promise<IfMatchContext>,
  stateTokenMatches: (token: string, path: Path) => Promise<boolean> = () =>
    Promise.resolve(false),
) => {
  for (const list of header) {
    const resource = list.resource ?? requestPath;
    const context = await contextFor(resource);
    if (
      await Promise.all(
        list.conditions.map(async (condition) => {
          const matches =
            condition.kind === "entity-tag"
              ? context.etag === condition.etag
              : condition.token === "DAV:no-lock"
                ? false
                : context.lockTokens.has(condition.token) ||
                  (await stateTokenMatches(condition.token, resource));
          return condition.not ? !matches : matches;
        }),
      ).then((matches) => matches.every(Boolean))
    )
      return true;
  }
  return false;
};
