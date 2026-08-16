import type {
  DavIfCondition,
  DavIfHeader,
  DavIfList,
  EntityTag,
  Path,
} from "../../interfaces";
import { FileSystemError } from "../../filesystem";
import { decodePath } from "../../path";

interface IfMatchContext {
  etag?: EntityTag;
  lockTokens: ReadonlySet<string>;
}

export const parseIfHeader = (header: string): DavIfHeader => {
  const value = header.trim();
  if (!value) return [];

  let index = 0;
  const lists: DavIfList[] = [];
  const skipSpace = () => {
    while (index < value.length && /\s/.test(value[index])) index += 1;
  };
  const parseTag = () => {
    const start = index;
    index += 1;
    while (index < value.length && value[index] !== ">") index += 1;
    if (index === value.length)
      throw new FileSystemError("invalid-if", "Invalid If header");
    const token = value.slice(start + 1, index);
    index += 1;
    return token;
  };
  const parseEtag = (): EntityTag => {
    const start = index + 1;
    index += 1;
    while (index < value.length && value[index] !== "]") index += 1;
    if (index === value.length)
      throw new FileSystemError("invalid-if", "Invalid If header");
    const etag = value.slice(start, index);
    index += 1;
    if (!/^(?:W\/)?"/.test(etag) || !etag.endsWith('"'))
      throw new FileSystemError("invalid-if", "Invalid If header");
    return etag as EntityTag;
  };
  const parseCondition = (): DavIfCondition => {
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
    throw new FileSystemError("invalid-if", "Invalid If header");
  };
  const parseList = (resource?: Path): DavIfList => {
    skipSpace();
    if (value[index] !== "(")
      throw new FileSystemError("invalid-if", "Invalid If header");
    index += 1;
    const conditions: DavIfCondition[] = [];
    while (true) {
      skipSpace();
      if (value[index] === ")") {
        index += 1;
        break;
      }
      if (index >= value.length)
        throw new FileSystemError("invalid-if", "Invalid If header");
      conditions.push(parseCondition());
    }
    if (!conditions.length)
      throw new FileSystemError("invalid-if", "Invalid If header");
    return { ...(resource ? { resource } : {}), conditions };
  };
  const parseResource = (): Path => {
    const tag = parseTag();
    try {
      const pathname = tag.startsWith("/") ? tag : new URL(tag).pathname;
      return decodePath(pathname);
    } catch {
      throw new FileSystemError("invalid-if", "Invalid If header");
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

const matchesCondition = async (
  condition: DavIfCondition,
  context: IfMatchContext,
  stateTokenMatches: (token: string) => Promise<boolean>,
) => {
  const matches =
    condition.kind === "entity-tag"
      ? context.etag === condition.etag
      : condition.token === "DAV:no-lock"
        ? false
        : context.lockTokens.has(condition.token) ||
          (await stateTokenMatches(condition.token));
  return condition.not ? !matches : matches;
};

export const ifHeaderMatches = async (
  header: DavIfHeader,
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
        list.conditions.map(async (condition) =>
          matchesCondition(condition, context, (token) =>
            stateTokenMatches(token, resource),
          ),
        ),
      ).then((matches) => matches.every(Boolean))
    )
      return true;
  }
  return false;
};
