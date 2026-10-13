import fs from 'node:fs';
import ts from 'typescript';
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+entry.name;if(entry.isDirectory())walk(p);else if(p.endsWith('.ts'))files.push(p);}}
walk('src');
const result=[];
for(const file of files){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 function visit(node){
  if(ts.isFunctionLike(node)&&node.body){
   let branches=1;
   function count(child){
    if(child!==node&&ts.isFunctionLike(child))return;
    if(ts.isIfStatement(child)||ts.isForStatement(child)||ts.isForInStatement(child)||ts.isForOfStatement(child)||ts.isWhileStatement(child)||ts.isDoStatement(child)||ts.isCaseClause(child)||ts.isCatchClause(child)||ts.isConditionalExpression(child))branches++;
    if(ts.isBinaryExpression(child)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind))branches++;
    ts.forEachChild(child,count);
   }
   count(node);
   const first=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
   const last=source.getLineAndCharacterOfPosition(node.end).line+1;
   result.push({file,name:node.name?.getText(source)||'anonymous',line:first,lines:last-first+1,branchApprox:branches});
  }
  ts.forEachChild(node,visit);
 }
 visit(source);
}
result.sort((a,b)=>b.branchApprox-a.branchApprox||b.lines-a.lines);
const output={method:'TypeScript AST: 1 + if/loops/non-default cases/catch/ternaries/&&/||/??, excluding nested functions; approximate, not canonical cyclomatic complexity. TS source only; HTML frontend excluded.',functions:result.length,top:result.slice(0,12)};
fs.writeFileSync('thoughts/audit/structural-metrics.json',JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
