import ts from 'typescript';
import { join } from 'path';

export interface DiscoveredMethod {
  name: string;
  signature: string;
  returnType: string;
}

export interface DiscoveredPort {
  name: string;
  definingFile: string;
  methods: DiscoveredMethod[];
  owner: string;
}

const OWNERSHIP_RULES = [
  { match: /EventStore/, owner: 'Dev 3' }, // Port belongs to Dev 3
  { match: /StateMachine/, owner: 'Dev 3' },
  { match: /Replay/, owner: 'Dev 3' },
  { match: /Outbox.*Delivery/, owner: 'Dev 3' },
  { match: /Repository|UnitOfWork/, owner: 'Dev 2' },
];

export function determineCanonicalOwner(interfaceName: string): string {
  for (const rule of OWNERSHIP_RULES) {
    if (rule.match.test(interfaceName)) {
      return rule.owner;
    }
  }
  return 'Unknown';
}

export function discoverCanonicalPorts(rootDir: string, files: string[]): DiscoveredPort[] {
  const ports: DiscoveredPort[] = [];
  
  const program = ts.createProgram(files.map(f => join(rootDir, f)), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS
  });
  const checker = program.getTypeChecker();

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile && !sourceFile.fileName.includes('node_modules')) {
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
          // Must be exported
          const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
          if (!isExported) return;

          const symbol = checker.getSymbolAtLocation(node.name);
          if (!symbol) return;

          const name = symbol.getName();
          // Filter out typical internal types or non-ports
          if (!name.includes('Repository') && !name.includes('UnitOfWork') && !name.includes('EventStore') && !name.includes('StateMachine') && !name.includes('Replay')) {
            return;
          }

          const methods: DiscoveredMethod[] = [];
          if (ts.isInterfaceDeclaration(node)) {
            const type = checker.getTypeAtLocation(node);
            const properties = checker.getPropertiesOfType(type);
            
            for (const prop of properties) {
              const propType = checker.getTypeOfSymbolAtLocation(prop, node);
              const signatures = propType.getCallSignatures();
              
              if (signatures.length > 0) {
                // It's a method
                for (const sig of signatures) {
                  const returnTypeStr = checker.typeToString(sig.getReturnType());
                  const sigStr = checker.signatureToString(sig);
                  methods.push({
                    name: prop.getName(),
                    signature: sigStr,
                    returnType: returnTypeStr
                  });
                }
              }
            }
          }

          ports.push({
            name,
            definingFile: sourceFile.fileName.replace(rootDir, '').replace(/^\\|\//, ''),
            methods,
            owner: determineCanonicalOwner(name)
          });
        }
      });
    }
  }
  
  return ports;
}
