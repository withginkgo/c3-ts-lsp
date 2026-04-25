import fs from "node:fs";
import Parser from "tree-sitter";
import C3 from "tree-sitter-c3/bindings/node/index.js";

const parser = new Parser();
parser.setLanguage(C3 as Parser.Language);

const source = fs.readFileSync("testdata/simple/main.c3", "utf8");
const tree = parser.parse(source);

console.log(tree.rootNode.toString());

console.log("\n=== top level nodes ===");

for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const node = tree.rootNode.namedChild(i);
    if (!node) continue;

    console.log(`${i}: ${node.type} => ${node.text.split("\n")[0]}`);
}