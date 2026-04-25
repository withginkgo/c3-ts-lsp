import fs from "node:fs";
import Parser, { SyntaxNode } from "tree-sitter";
import C3 from "tree-sitter-c3/bindings/node/index.js";

const parser = new Parser();
parser.setLanguage(C3 as Parser.Language);

const source = fs.readFileSync("testdata/simple/main.c3", "utf8");
const tree = parser.parse(source);

const moduleName = extractModuleName(tree.rootNode);

console.log("module:", moduleName);
console.log("symbols:");

for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const node = tree.rootNode.namedChild(i);
    if (!node) continue;

    if (
        node.type !== "struct_declaration" &&
        node.type !== "func_definition" &&
        node.type !== "enum_declaration" &&
        node.type !== "interface_declaration"
    ) {
        continue;
    }

    const nameNode = extractNameNode(node);
    if (!nameNode) {
        console.log("  [no name]", node.type);
        continue;
    }

    console.log(`  ${node.type}: ${nameNode.text} => ${compactSignature(node)}`);
}

function extractModuleName(root: SyntaxNode): string {
    for (let i = 0; i < root.namedChildCount; i++) {
        const child = root.namedChild(i);
        if (!child) continue;

        if (child.type === "module_declaration") {
            const path = child.childForFieldName("path");
            return path?.text ?? "";
        }
    }

    return "";
}

function extractNameNode(node: SyntaxNode): SyntaxNode | null {
    if (node.type === "func_definition") {
        const header = findFirstDescendantOfType(node, "func_header");
        if (!header) return null;

        const name = header.childForFieldName("name");
        if (name) return name;

        return findFirstDescendantOfTypes(header, ["ident"]);
    }

    const name = node.childForFieldName("name");
    if (name) return name;

    return findFirstDescendantOfTypes(node, [
        "ident",
        "type_ident",
        "const_ident",
    ]);
}

function compactSignature(node: SyntaxNode): string {
    if (node.type === "func_definition") {
        const header = findFirstDescendantOfType(node, "func_header");
        const params = findFirstDescendantOfType(node, "func_param_list");

        if (header && params) {
            return `${header.text}${params.text}`;
        }

        const brace = node.text.indexOf("{");
        if (brace >= 0) return node.text.slice(0, brace).trim();
    }

    const brace = node.text.indexOf("{");
    if (brace >= 0) return node.text.slice(0, brace).trim();

    return node.text.trim();
}

function findFirstDescendantOfType(
    node: SyntaxNode,
    type: string,
): SyntaxNode | null {
    if (node.type === type) return node;

    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;

        const found = findFirstDescendantOfType(child, type);
        if (found) return found;
    }

    return null;
}

function findFirstDescendantOfTypes(
    node: SyntaxNode,
    types: string[],
): SyntaxNode | null {
    if (types.includes(node.type)) return node;

    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;

        const found = findFirstDescendantOfTypes(child, types);
        if (found) return found;
    }

    return null;
}