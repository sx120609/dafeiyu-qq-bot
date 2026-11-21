import {normalizeUsage} from './server.mjs';
import {rateLimitError} from './provider-health.mjs';

const fields=['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','thinkingTokens','costUSD'];
const number=value=>Number.isFinite(value)&&value>=0?value:0;

// 2026-11-21: "Find the root cause". SDK modelUsage includes auxiliary models and is cumulative;
// its first key is not the answering model and its prices are estimates, not the proxy's invoice.
export class ClaudeUsageMeter{
  constructor(){this.models={};this.cost=0;}
  read(result,requestedModel,answerModel){
    const total=number(result.total_cost_usd),cost=Math.max(0,total-this.cost);
    this.cost=Math.max(this.cost,total);
    const entries=Object.entries(result.modelUsage||{});
    const model=answerModel||entries.find(([name])=>name===requestedModel||name.startsWith(`claude-${requestedModel}-`))?.[0]
      ||(entries.length===1?entries[0][0]:requestedModel);
    const breakdown=[];let detailed=false;
    for(const [name,value] of entries){
      if(!value||!fields.some(field=>Number.isFinite(value[field])))continue;
      detailed=true;
      const previous=this.models[name]||{},delta={};
      for(const field of fields)delta[field]=Math.max(0,number(value[field])-number(previous[field]));
      this.models[name]=Object.fromEntries(fields.map(field=>[field,Math.max(number(previous[field]),number(value[field]))]));
      if(!fields.some(field=>delta[field]>0))continue;
      breakdown.push({model:name,usage:normalizeUsage({input_tokens:delta.inputTokens,output_tokens:delta.outputTokens,
        cache_read_input_tokens:delta.cacheReadInputTokens,cache_creation_input_tokens:delta.cacheCreationInputTokens,
        reasoning_output_tokens:delta.thinkingTokens,...(Number.isFinite(value.costUSD)?{cost_usd:delta.costUSD}:{})})});
    }
    const usage=normalizeUsage({...result.usage,cost_usd:cost});
    if(detailed){
      for(const field of ['prompt_tokens','completion_tokens','total_tokens','cached_tokens','reasoning_tokens'])
        usage[field]=breakdown.reduce((sum,item)=>sum+item.usage[field],0);
      usage.model_usage=breakdown.length?breakdown:[{model,usage:normalizeUsage({cost_usd:cost})}];
    }
    return {model,usage};
  }
}

export function claudeResultError(result,metered,retryAfter=60){
  const categories=['error_during_execution','error_max_turns','error_max_budget_usd','error_max_structured_output_retries'];
  const category=categories.includes(result?.subtype)?result.subtype:result?.is_error?'claude_result_error':'claude_missing_structured_output';
  const limited=result?.is_error?rateLimitError(JSON.stringify(result),retryAfter):null;
  return Object.assign(limited||new Error(`Claude 未返回有效结构化回复，请检查登录与额度（${category}）`),metered,
    {usageFailure:limited?'rate_limit':category});
}
