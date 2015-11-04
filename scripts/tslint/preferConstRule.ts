/// <reference path="../../node_modules/tslint/typings/typescriptServices.d.ts" />
/// <reference path="../../node_modules/tslint/lib/tslint.d.ts" />


export class Rule extends Lint.Rules.AbstractRule {
    public static FAILURE_STRING_FACTORY = (identifier: string) => `Identifier '${identifier}' never appears on the LHS of an assignment - use const instead of let for its declaration.`;

    public apply(sourceFile: ts.SourceFile): Lint.RuleFailure[] {
        return this.applyWithWalker(new PreferConstWalker(sourceFile, this.getOptions()));
    }
}

function isBindingPattern(node: ts.Node): node is ts.BindingPattern {
    return !!node && (node.kind === ts.SyntaxKind.ArrayBindingPattern || node.kind === ts.SyntaxKind.ObjectBindingPattern);
}

function walkUpBindingElementsAndPatterns(node: ts.Node): ts.Node {
    while (node && (node.kind === ts.SyntaxKind.BindingElement || isBindingPattern(node))) {
        node = node.parent;
    }

    return node;
}

function getCombinedNodeFlags(node: ts.Node): ts.NodeFlags {
    node = walkUpBindingElementsAndPatterns(node);

    let flags = node.flags;
    if (node.kind === ts.SyntaxKind.VariableDeclaration) {
        node = node.parent;
    }

    if (node && node.kind === ts.SyntaxKind.VariableDeclarationList) {
        flags |= node.flags;
        node = node.parent;
    }

    if (node && node.kind === ts.SyntaxKind.VariableStatement) {
        flags |= node.flags;
    }

    return flags;
}

function isLet(node: ts.Node) {
    return !!(getCombinedNodeFlags(node) & ts.NodeFlags.Let);
}

function isExported(node: ts.Node) {
    return !!(getCombinedNodeFlags(node) & ts.NodeFlags.Export);
}

function isAssignmentOperator(token: ts.SyntaxKind): boolean {
    return token >= ts.SyntaxKind.FirstAssignment && token <= ts.SyntaxKind.LastAssignment;
}

function isBindingLiteralExpression(node: ts.Node): node is (ts.ArrayLiteralExpression | ts.ObjectLiteralExpression) {
    return (!!node) && (node.kind === ts.SyntaxKind.ObjectLiteralExpression || node.kind === ts.SyntaxKind.ArrayLiteralExpression);
}

interface DeclarationUsages {
    declaration: ts.VariableDeclaration;
    usages: number;
}

class PreferConstWalker extends Lint.RuleWalker {
    private inScopeLetDeclarations: ts.Map<DeclarationUsages>[] = [];
    private errors: Lint.RuleFailure[] = [];
    private markAssignment(identifier: ts.Identifier) {
        const name = identifier.text;
        for (let i = this.inScopeLetDeclarations.length - 1; i >= 0; i--) {
            const declarations = this.inScopeLetDeclarations[i];
            if (declarations[name]) {
                declarations[name].usages++;
                break;
            }
        }
    }

    visitSourceFile(node: ts.SourceFile) {
        super.visitSourceFile(node);
        // Sort errors by position because tslint doesn't
        this.errors.sort((a, b) => a.getStartPosition().getPosition() - b.getStartPosition().getPosition()).forEach(e => this.addFailure(e));
    }

    visitBinaryExpression(node: ts.BinaryExpression) {
        if (isAssignmentOperator(node.operatorToken.kind)) {
            this.visitLHSExpressions(node.left);
        }
        super.visitBinaryExpression(node);
    }

    private visitLHSExpressions(node: ts.Expression) {
        while (node.kind === ts.SyntaxKind.ParenthesizedExpression) {
            node = (node as ts.ParenthesizedExpression).expression;
        }
        if (node.kind === ts.SyntaxKind.Identifier) {
            this.markAssignment(node as ts.Identifier);
        }
        else if (isBindingLiteralExpression(node)) {
            this.visitBindingLiteralExpression(node as (ts.ArrayLiteralExpression | ts.ObjectLiteralExpression));
        }
    }
    
    private visitBindingLiteralExpression(node: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression) {
        if (node.kind === ts.SyntaxKind.ObjectLiteralExpression) {
            const pattern = node as ts.ObjectLiteralExpression;
            for (let i = 0; i < pattern.properties.length; i++) {
                const element = pattern.properties[i];
                if (element.name.kind === ts.SyntaxKind.Identifier) {
                    this.markAssignment(element.name as ts.Identifier)
                }
                else if (isBindingPattern(element.name)) {
                    this.visitBindingPatternIdentifiers(element.name as ts.BindingPattern);
                }
            }
        }
        else if (node.kind === ts.SyntaxKind.ArrayLiteralExpression) {
            const pattern = node as ts.ArrayLiteralExpression;
            for (let i = 0; i < pattern.elements.length; i++) {
                const element = pattern.elements[i];
                this.visitLHSExpressions(element);
            }
        }
    }

    private visitBindingPatternIdentifiers(pattern: ts.BindingPattern) {
        for (let i = 0; i < pattern.elements.length; i++) {
            const element = pattern.elements[i];
            if (element.name.kind === ts.SyntaxKind.Identifier) {
                this.markAssignment(element.name as ts.Identifier);
            }
            else {
                this.visitBindingPatternIdentifiers(element.name as ts.BindingPattern);
            }
        }
    }

    visitPrefixUnaryExpression(node: ts.PrefixUnaryExpression) {
        this.visitAnyUnaryExpression(node);
        super.visitPrefixUnaryExpression(node);
    }

    visitPostfixUnaryExpression(node: ts.PostfixUnaryExpression) {
        this.visitAnyUnaryExpression(node);
        super.visitPostfixUnaryExpression(node);
    }

    private visitAnyUnaryExpression(node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression) {
        if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
            this.visitLHSExpressions(node.operand);
        }
    }

    visitModuleDeclaration(node: ts.ModuleDeclaration) {
        if (node.body.kind === ts.SyntaxKind.ModuleBlock) {
            // For some reason module blocks are left out of the visit block traversal
            this.visitBlock(node.body as ts.ModuleBlock);
        }
        super.visitModuleDeclaration(node);
    }

    visitForOfStatement(node: ts.ForOfStatement) {
        this.visitAnyForStatement(node);
        super.visitForOfStatement(node);
        this.popDeclarations();
    }

    visitForInStatement(node: ts.ForInStatement) {
        this.visitAnyForStatement(node);
        super.visitForInStatement(node);
        this.popDeclarations();
    }

    private visitAnyForStatement(node: ts.ForOfStatement | ts.ForInStatement) {
        const names: ts.Map<DeclarationUsages> = {};
        if (isLet(node.initializer)) {
            if (node.initializer.kind === ts.SyntaxKind.VariableDeclarationList) {
                this.collectLetIdentifiers(node.initializer as ts.VariableDeclarationList, names);
            }
        }
        this.inScopeLetDeclarations.push(names);
    }

    private popDeclarations() {
        const completed = this.inScopeLetDeclarations.pop();
        for (const name in completed) {
            if (Object.hasOwnProperty.call(completed, name)) {
                const element = completed[name];
                if (element.usages === 0) {
                    this.errors.push(this.createFailure(element.declaration.getStart(this.getSourceFile()), element.declaration.getWidth(this.getSourceFile()), Rule.FAILURE_STRING_FACTORY(name)));
                }
            }
        }
    }

    visitBlock(node: ts.Block) {
        const names: ts.Map<DeclarationUsages> = {};
        for (let i = 0; i < node.statements.length; i++) {
            const statement = node.statements[i];
            if (statement.kind === ts.SyntaxKind.VariableStatement) {
                this.collectLetIdentifiers((statement as ts.VariableStatement).declarationList, names);
            }
        }
        this.inScopeLetDeclarations.push(names);
        super.visitBlock(node);
        this.popDeclarations();
    }

    private collectLetIdentifiers(list: ts.VariableDeclarationList, ret: ts.Map<DeclarationUsages>) {
        const children = list.declarations;
        for (let i = 0; i < children.length; i++) {
            const node = children[i];
            if (isLet(node) && !isExported(node)) {
                this.collectNameIdentifiers(node, node.name, ret);
            }
        }
    }

    private collectNameIdentifiers(value: ts.VariableDeclaration, node: ts.Identifier | ts.BindingPattern, table: ts.Map<DeclarationUsages>) {
        if (node.kind === ts.SyntaxKind.Identifier) {
            table[(node as ts.Identifier).text] = {declaration: value, usages: 0};
        }
        else {
            this.collectBindingPatternIdentifiers(value, node as ts.BindingPattern, table);
        }
    }

    private collectBindingPatternIdentifiers(value: ts.VariableDeclaration, pattern: ts.BindingPattern, table: ts.Map<DeclarationUsages>) {
        for (let i = 0; i < pattern.elements.length; i++) {
            const element = pattern.elements[i];
            this.collectNameIdentifiers(value, element.name, table);
        }
    }
}
