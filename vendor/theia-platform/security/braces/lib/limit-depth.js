'use strict';

// Public compile/stringify/expand also accept caller-created ASTs. Check those
// iteratively so bypassing parse() cannot reach an unbounded recursive walker.
module.exports = ast => {
  const stack = [[ast, 0, false]];
  const active = new Set();
  while (stack.length) {
    const [node, depth, leave] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (leave) {
      active.delete(node);
      continue;
    }
    if (depth > 256 || active.has(node)) {
      throw new SyntaxError('Brace nesting exceeds the supported AST depth');
    }
    active.add(node);
    stack.push([node, depth, true]);
    for (const child of node.nodes || []) stack.push([child, depth + 1, false]);
  }
};
