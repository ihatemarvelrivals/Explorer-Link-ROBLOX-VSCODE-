#!/usr/bin/env python3
"""Structural sanity check for the plugin's Luau sources.

This is not a Luau parser and does not replace `luau-analyze`. It catches the class of
mistake that is easy to make and annoying to find inside Studio — an unbalanced block or
bracket, or a `require` pointing at a module that is not there — without needing a
toolchain.

    python3 tools/check_lua.py [plugin/src]

Luau specifics it handles: long strings and long comments, `continue`, compound
assignment, `::` type casts, and if-expressions (`local x = if a then b else c`), which
unlike if-statements take no `end`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Tokens after which an `if` begins an expression rather than a statement.
# `then`, `else` and `do` are deliberately absent: an `if` straight after one of those
# opens a nested block, which is by far the more common shape.
EXPRESSION_LEAD = {
    '=', '(', ',', '{', '[', 'return', 'and', 'or', 'not', '..', '==', '~=',
    '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '^',
}

WORD = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
LONG_OPEN = re.compile(r'\[(=*)\[')


def strip(source: str) -> str:
    """Removes comments and string literals, leaving structure behind."""
    out: list[str] = []
    i = 0
    n = len(source)

    while i < n:
        ch = source[i]

        # long comment / long string
        if source.startswith('--', i):
            rest = source[i + 2:]
            match = LONG_OPEN.match(rest)
            if match:
                closer = ']' + '=' * len(match.group(1)) + ']'
                end = source.find(closer, i + 2 + match.end())
                i = n if end < 0 else end + len(closer)
            else:
                end = source.find('\n', i)
                i = n if end < 0 else end
            continue

        match = LONG_OPEN.match(source, i)
        if match:
            closer = ']' + '=' * len(match.group(1)) + ']'
            end = source.find(closer, match.end())
            i = n if end < 0 else end + len(closer)
            out.append(' "" ')
            continue

        if ch in '"\'':
            i += 1
            while i < n and source[i] != ch:
                i += 2 if source[i] == '\\' else 1
            i += 1
            out.append(' "" ')
            continue

        out.append(ch)
        i += 1

    return ''.join(out)


def tokenize(source: str) -> list[tuple[str, int]]:
    tokens: list[tuple[str, int]] = []
    line = 1
    i = 0
    n = len(source)
    two_char = {'==', '~=', '<=', '>=', '..', '::', '+=', '-=', '*=', '/=', '->'}

    while i < n:
        ch = source[i]
        if ch == '\n':
            line += 1
            i += 1
            continue
        if ch.isspace():
            i += 1
            continue
        match = WORD.match(source, i)
        if match:
            tokens.append((match.group(0), line))
            i = match.end()
            continue
        if source[i:i + 2] in two_char:
            tokens.append((source[i:i + 2], line))
            i += 2
            continue
        tokens.append((ch, line))
        i += 1

    return tokens


def check_blocks(tokens: list[tuple[str, int]], path: Path) -> list[str]:
    problems: list[str] = []
    stack: list[tuple[str, int, bool]] = []  # (kind, line, opened)
    pending_expr_then = 0
    last_if_was_expression = False
    brackets: list[tuple[str, int]] = []
    pairs = {')': '(', ']': '[', '}': '{'}

    previous = ''
    for token, line in tokens:
        if token in '([{':
            brackets.append((token, line))
        elif token in ')]}':
            if not brackets:
                problems.append(f'{path}:{line}: stray {token!r}')
            elif brackets[-1][0] != pairs[token]:
                opener, opener_line = brackets[-1]
                problems.append(
                    f'{path}:{line}: {token!r} closes {opener!r} opened on line {opener_line}'
                )
                brackets.pop()
            else:
                brackets.pop()

        elif token == 'if':
            if previous in EXPRESSION_LEAD:
                pending_expr_then += 1
                last_if_was_expression = True
            else:
                stack.append(('if', line, False))
                last_if_was_expression = False

        elif token == 'elseif':
            if last_if_was_expression:
                pending_expr_then += 1

        elif token == 'then':
            if pending_expr_then > 0:
                pending_expr_then -= 1
            elif stack and stack[-1][0] == 'if' and not stack[-1][2]:
                kind, opened_line, _ = stack[-1]
                stack[-1] = (kind, opened_line, True)
            # else: an `elseif ... then` in a statement chain — nothing to open.

        elif token in ('for', 'while'):
            stack.append((token, line, False))

        elif token == 'do':
            if stack and stack[-1][0] in ('for', 'while') and not stack[-1][2]:
                kind, opened_line, _ = stack[-1]
                stack[-1] = (kind, opened_line, True)
            else:
                stack.append(('do', line, True))

        elif token == 'function':
            stack.append(('function', line, True))

        elif token == 'repeat':
            stack.append(('repeat', line, True))

        elif token == 'until':
            if stack and stack[-1][0] == 'repeat':
                stack.pop()
            else:
                problems.append(f'{path}:{line}: `until` with no matching `repeat`')

        elif token == 'end':
            if not stack:
                problems.append(f'{path}:{line}: `end` with nothing open')
            elif stack[-1][0] == 'repeat':
                problems.append(f'{path}:{line}: `end` closing a `repeat` (needs `until`)')
                stack.pop()
            else:
                stack.pop()

        previous = token

    for kind, line, _ in stack:
        problems.append(f'{path}:{line}: `{kind}` is never closed')
    for opener, line in brackets:
        problems.append(f'{path}:{line}: {opener!r} is never closed')
    if pending_expr_then:
        problems.append(f'{path}: {pending_expr_then} if-expression(s) missing a `then`')

    return problems


REQUIRE = re.compile(r'require\(script(?:\.Parent)?\.([A-Za-z_][A-Za-z0-9_]*)\)')


def check_requires(source: str, path: Path, available: set[str]) -> list[str]:
    problems = []
    for match in REQUIRE.finditer(source):
        name = match.group(1)
        if name not in available:
            line = source[: match.start()].count('\n') + 1
            problems.append(f'{path}:{line}: require of `{name}`, which is not a module here')
    return problems


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else 'plugin/src').resolve()
    files = sorted(root.glob('*.lua'))
    if not files:
        print(f'no .lua files under {root}')
        return 1

    available = {p.stem for p in files if not p.name.endswith('.server.lua')}

    problems: list[str] = []
    for path in files:
        source = path.read_text(encoding='utf-8')
        stripped = strip(source)
        problems += check_blocks(tokenize(stripped), path.relative_to(root.parent.parent))
        problems += check_requires(stripped, path.relative_to(root.parent.parent), available)

    for problem in problems:
        print(problem)

    print(f'\n{len(files)} files checked, {len(problems)} problem(s)')
    return 1 if problems else 0


if __name__ == '__main__':
    raise SystemExit(main())
