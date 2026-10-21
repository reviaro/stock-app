'use strict';
// Deterministic scenario calculator, never a price target inferred by an LLM.
function calculateValuation(input){
    if(!['enterprise','equity'].includes(input?.cashFlowBasis))throw Error('Specify enterprise or equity cash-flow basis');
    if(input.cashFlowBasis==='equity'&&input.netDebt!==0)throw Error('Equity cash flow must not subtract net debt again');
    for(const key of ['freeCashFlow','sharesOutstanding','netDebt','growthPct','discountPct','terminalGrowthPct','years']){
        if(typeof input?.[key]!=='number'||!Number.isFinite(input[key]))throw Error('Provide finite numeric valuation assumptions');
    }
    const {freeCashFlow:fcf,sharesOutstanding:shares,netDebt,growthPct:g,discountPct:r,terminalGrowthPct:t,years}=input;
    if(fcf<=0||shares<=0||!Number.isInteger(years)||years<1||years>10||g< -50||g>50||r<=0||r>50||t< -5||t>5||r-t<1)throw Error('Unsupported valuation assumptions; discount must exceed terminal growth by at least one percentage point');
    const scenario=(growth,discount)=>{
        let value=0,cash=fcf;
        for(let year=1;year<=years;year++){cash*=1+growth/100;value+=cash/(1+discount/100)**year;}
        const terminal=cash*(1+t/100)/((discount-t)/100);
        value+=terminal/(1+discount/100)**years;
        return Math.max(0,(value-netDebt)/shares);
    };
    const base=scenario(g,r),low=scenario(Math.max(-50,g-2),r+2),high=scenario(Math.min(50,g+2),Math.max(.1,t+1,r-2));
    if(![base,low,high].every(Number.isFinite))throw Error('Valuation assumptions exceed numeric range');
    return {method:input.cashFlowBasis+' cash-flow scenario DCF',assumptions:input,basePerShare:base,lowPerShare:Math.min(low,base,high),highPerShare:Math.max(low,base,high),
        limitations:['Scenario assumptions are supplied explicitly, not verified forecasts.','Equity cash flow uses zero net-debt subtraction; enterprise cash flow must be explicitly derived before subtracting net debt.','Sensitivity is not a statistical confidence interval.']};
}
module.exports={calculateValuation};
