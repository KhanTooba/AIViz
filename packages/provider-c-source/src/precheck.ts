/**
 * Supportability precheck.
 *
 * Deliberately an allow-list, not a deny-list. tree-sitter happily parses C we
 * have no semantics for, and silently analysing something we do not model would
 * produce confidently wrong invariants. Anything not explicitly known is
 * reported as unsupported, with an exact line and a reason a learner can act on.
 */

import type { Diagnostic } from '@aiviz/trace-protocol';
import type { Node } from 'web-tree-sitter';
import { namedDescendants } from './parser.js';

/** Named node types the analysis fully understands. */
const ALLOWED = new Set([
  // declarations and functions
  'function_definition',
  'function_declarator',
  'parameter_list',
  'parameter_declaration',
  'primitive_type',
  'sized_type_specifier',
  'type_identifier',
  'declaration',
  'init_declarator',
  'identifier',
  'number_literal',
  'true',
  'false',
  'null',
  'comment',
  // statements
  'compound_statement',
  'expression_statement',
  'if_statement',
  'else_clause',
  'while_statement',
  'for_statement',
  'do_statement',
  'break_statement',
  'continue_statement',
  'return_statement',
  // expressions
  'assignment_expression',
  'update_expression',
  'binary_expression',
  'unary_expression',
  'parenthesized_expression',
]);

/** Constructs we recognise and can explain precisely. */
const REJECTED: Record<string, { code: string; message: string }> = {
  pointer_declarator: { code: 'unsupported.pointer', message: 'pointers are not supported' },
  pointer_expression: {
    code: 'unsupported.pointer',
    message: 'pointer dereference and address-of are not supported',
  },
  abstract_pointer_declarator: {
    code: 'unsupported.pointer',
    message: 'pointers are not supported',
  },
  array_declarator: { code: 'unsupported.array', message: 'arrays are not supported' },
  subscript_expression: {
    code: 'unsupported.array',
    message: 'array indexing is not supported',
  },
  struct_specifier: { code: 'unsupported.struct', message: 'structs are not supported' },
  union_specifier: { code: 'unsupported.struct', message: 'unions are not supported' },
  enum_specifier: { code: 'unsupported.enum', message: 'enums are not supported' },
  field_expression: {
    code: 'unsupported.struct',
    message: 'struct field access is not supported',
  },
  initializer_list: {
    code: 'unsupported.aggregate',
    message: 'aggregate initializers are not supported',
  },
  call_expression: {
    code: 'unsupported.call',
    message: 'function calls are not supported; analysis is intraprocedural',
  },
  goto_statement: { code: 'unsupported.goto', message: '`goto` is not supported' },
  labeled_statement: { code: 'unsupported.goto', message: 'labels are not supported' },
  switch_statement: { code: 'unsupported.switch', message: '`switch` is not supported' },
  case_statement: { code: 'unsupported.switch', message: '`case` is not supported' },
  cast_expression: { code: 'unsupported.cast', message: 'casts are not supported' },
  sizeof_expression: { code: 'unsupported.sizeof', message: '`sizeof` is not supported' },
  char_literal: {
    code: 'unsupported.type',
    message: 'character literals are not supported',
  },
  string_literal: { code: 'unsupported.type', message: 'strings are not supported' },
  concatenated_string: { code: 'unsupported.type', message: 'strings are not supported' },
  conditional_expression: {
    code: 'unsupported.ternary',
    message: 'the ternary `?:` operator is not supported',
  },
  comma_expression: {
    code: 'unsupported.comma',
    message: 'the comma operator is not supported',
  },
};

const FLOAT_TYPES = new Set(['float', 'double', 'long double']);

/** Binary/unary operators the domains implement. */
const BINARY_OPS = new Set(['+', '-', '*', '/', '%', '<', '<=', '>', '>=', '==', '!=', '&&', '||']);
const UNARY_OPS = new Set(['-', '!', '+']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

function diag(node: Node, code: string, message: string): Diagnostic {
  return {
    severity: 'error',
    code,
    message,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

/**
 * Checks one function. Returns every reason it cannot be analysed, so the user
 * sees the whole picture rather than fixing one thing at a time.
 */
export function precheckFunction(fn: Node): Diagnostic[] {
  const out: Diagnostic[] = [];

  // A parse failure must be fatal: tree-sitter recovers from broken C without
  // complaint, and analysing a mis-parsed program is worse than refusing.
  if (fn.hasError) {
    for (const node of [fn, ...namedDescendants(fn)]) {
      if (node.type === 'ERROR' || node.isMissing) {
        out.push(
          diag(
            node,
            'parse.error',
            node.isMissing
              ? `syntax error: expected ${node.type}`
              : 'syntax error: this code could not be parsed'
          )
        );
      }
    }
    if (out.length > 0) return out;
  }

  for (const node of namedDescendants(fn)) {
    const rejected = REJECTED[node.type];
    if (rejected) {
      out.push(diag(node, rejected.code, rejected.message));
      continue;
    }

    if (!ALLOWED.has(node.type)) {
      out.push(
        diag(node, 'unsupported.construct', `\`${node.type}\` is not supported`)
      );
      continue;
    }

    if (node.type === 'primitive_type' && FLOAT_TYPES.has(node.text)) {
      out.push(
        diag(node, 'unsupported.float', `floating-point type \`${node.text}\` is not supported`)
      );
    }

    // Operators are unnamed tokens, so they need checking explicitly.
    if (node.type === 'binary_expression') {
      const op = node.childForFieldName('operator')?.text;
      if (op && !BINARY_OPS.has(op)) {
        out.push(diag(node, 'unsupported.operator', `operator \`${op}\` is not supported`));
      }
    }
    if (node.type === 'unary_expression') {
      const op = node.childForFieldName('operator')?.text;
      if (op && !UNARY_OPS.has(op)) {
        out.push(diag(node, 'unsupported.operator', `operator \`${op}\` is not supported`));
      }
    }
    if (node.type === 'assignment_expression') {
      const op = node.childForFieldName('operator')?.text;
      if (op && !ASSIGN_OPS.has(op)) {
        out.push(diag(node, 'unsupported.operator', `operator \`${op}\` is not supported`));
      }
    }
  }

  return dedupe(out);
}

/** One diagnostic per source position keeps the message list readable. */
function dedupe(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of items) {
    const key = `${d.line}:${d.column}:${d.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
}
