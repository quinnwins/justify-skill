"""Finds strings in Python files that could be words people see.

Reads a JSON list of {"file", "path"} on stdin and prints a JSON list of
candidates. justify.mjs decides which candidates count as copy, so the rules
match the JavaScript scanner.

Each candidate: {file, line, text, via, name}
  via  "call"    first text argument of a call (name = function name)
       "keyword" keyword argument (name = keyword)
       "key"     dict value (name = its key)
       "assign"  assigned to a variable or attribute (name = target)
       "bare"    any other string
"""

import ast
import json
import re
import sys

LOG_CALLEES = {
    "print", "debug", "info", "warning", "warn", "error", "exception", "critical", "log",
    "fatal", "captureException", "capture_exception", "capture_message", "breadcrumb",
}
LOG_OWNERS = {"logger", "logging", "log", "LOGGER", "LOG", "sentry_sdk", "current_app.logger", "app.logger", "warnings"}
DATA_CALLEES = {
    "get", "pop", "setdefault", "startswith", "endswith", "split", "rsplit", "strip", "replace", "join",
    "compile", "match", "search", "sub", "findall", "fullmatch", "execute", "executemany", "text",
    "getenv", "environ", "strftime", "strptime", "encode", "decode", "open", "read_sql", "query",
    "url_for", "redirect", "render_template", "send_from_directory", "getattr", "hasattr", "setattr",
    "isinstance", "format_datetime", "Path", "joinpath", "glob", "rglob", "loads", "dumps", "lower", "upper",
}
GETTEXT = {"_", "gettext", "ngettext", "lazy_gettext", "_l", "pgettext"}
# Command-line help is for developers, not customers.
CLI_CALLEES = {"add_argument", "ArgumentParser", "add_parser", "add_argument_group", "add_mutually_exclusive_group", "add_subparsers"}
CLICK_CALLEES = {"option", "argument", "command", "group"}
# Words sent to an AI model, not shown to people.
PROMPT_NAME = re.compile(r"(prompt|instruction|system_message|^system$|few_shot)", re.I)


def name_of(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Call):
        return name_of(node.func)
    if isinstance(node, ast.Subscript):
        sl = node.slice
        if isinstance(sl, ast.Index):  # Python 3.8
            sl = sl.value
        if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
            return sl.value
        return name_of(node.value)
    return "value"


def owner_of(func):
    if isinstance(func, ast.Attribute):
        try:
            return ast.unparse(func.value)
        except Exception:
            return ""
    return ""


def text_of(node):
    """Renders a string expression with {placeholders}, or None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for part in node.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                out.append(part.value)
            elif isinstance(part, ast.FormattedValue):
                out.append("{" + name_of(part.value) + "}")
        return "".join(out)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = text_of(node.left), text_of(node.right)
        if left is None and right is None:
            return None
        return (left if left is not None else "{" + name_of(node.left) + "}") + (
            right if right is not None else "{" + name_of(node.right) + "}"
        )
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
        left = text_of(node.left)
        if left is None:
            return None
        return re.sub(r"%\((\w+)\)[sdif]|%[sdif]", lambda m: "{" + (m.group(1) or "value") + "}", left)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format":
        return text_of(node.func.value)
    if isinstance(node, ast.IfExp):
        a, b = text_of(node.body), text_of(node.orelse)
        if a is not None and b is not None and a.strip() and b.strip():
            return "{" + a + "|" + b + "}"
    return None


def docstring_nodes(tree):
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, (ast.Constant, ast.JoinedStr)):
                out.add(id(body[0].value))
    return out


def scan(rel, full):
    src = open(full, encoding="utf-8", errors="replace").read()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child._parent = node
    skip = docstring_nodes(tree)
    hits = []
    seen = set()

    def emit(node, via, name=""):
        text = text_of(node)
        if text is None or id(node) in seen:
            return
        for sub in ast.walk(node):
            seen.add(id(sub))
        hits.append({"file": rel, "line": node.lineno, "text": text, "via": via, "name": name})

    def is_textish(node):
        return text_of(node) is not None

    def drop(node):
        for sub in ast.walk(node):
            seen.add(id(sub))

    for node in ast.walk(tree):
        if id(node) in skip:
            for sub in ast.walk(node):
                seen.add(id(sub))
            continue
        if isinstance(node, ast.Call):
            callee = name_of(node.func)
            owner = owner_of(node.func)
            if callee in LOG_CALLEES and (not owner or owner.split(".")[-1] in LOG_OWNERS or owner in LOG_OWNERS or callee == "print"):
                for sub in ast.walk(node):
                    seen.add(id(sub))
                continue
            if callee in CLI_CALLEES or (callee in CLICK_CALLEES and owner.endswith("click")):
                drop(node)
                continue
            if PROMPT_NAME.search(callee):
                drop(node)
                continue
            if callee in DATA_CALLEES:
                for arg in node.args:
                    drop(arg)
                for kw in node.keywords:
                    if kw.arg and is_textish(kw.value):
                        emit(kw.value, "keyword", kw.arg)
                continue
            if callee in GETTEXT and node.args:
                emit(node.args[0], "call", "gettext")
                continue
            texts = [a for a in node.args if is_textish(a)]
            if texts:
                emit(texts[0], "call", callee)
            for kw in node.keywords:
                if kw.arg and PROMPT_NAME.search(kw.arg):
                    drop(kw.value)
                elif kw.arg and is_textish(kw.value):
                    emit(kw.value, "keyword", kw.arg)
        elif isinstance(node, ast.Dict):
            keys = [k.value for k in node.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)]
            if "role" in keys and "content" in keys:  # a chat message to an AI model
                drop(node)
                continue
            if "type" in keys and "description" in keys:  # a JSON schema handed to an AI model
                types = [v.value for k, v in zip(node.keys, node.values)
                         if isinstance(k, ast.Constant) and k.value == "type" and isinstance(v, ast.Constant)]
                if any(t in ("string", "object", "array", "number", "integer", "boolean") for t in types):
                    drop(node)
                    continue
            for k, v in zip(node.keys, node.values):
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    seen.add(id(k))
                    if v is not None and PROMPT_NAME.search(k.value):
                        drop(v)
                    elif v is not None and is_textish(v):
                        emit(v, "key", k.value)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            target = name_of(targets[0])
            if node.value is not None and PROMPT_NAME.search(target):
                drop(node.value)
            elif node.value is not None and is_textish(node.value):
                emit(node.value, "assign", target)
        elif isinstance(node, ast.Compare):
            for sub in [node.left, *node.comparators]:
                for s in ast.walk(sub):
                    if isinstance(s, ast.Constant):
                        seen.add(id(s))
        elif isinstance(node, ast.Subscript):
            sl = node.slice
            for s in ast.walk(sl):
                seen.add(id(s))

    for node in ast.walk(tree):
        if id(node) in seen or id(node) in skip:
            continue
        if isinstance(node, (ast.Constant, ast.JoinedStr)) and is_textish(node):
            parent = getattr(node, "_parent", None)
            if isinstance(parent, ast.JoinedStr):
                continue
            emit(node, "bare")
    return hits


def main():
    files = json.load(sys.stdin)
    out = []
    for f in files:
        try:
            out.extend(scan(f["file"], f["path"]))
        except Exception as err:  # one odd file never stops the sweep
            print(f"skipped {f['file']}: {err}", file=sys.stderr)
    json.dump(out, sys.stdout)


main()
