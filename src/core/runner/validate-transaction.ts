import env from '../../config/env';
import { type TaskPayload, type TaskResult } from '../task-types';

interface SubnetTransaction {
    id: string;
    type: string;
    status: string;

    hash?: string;

    sourceAddress?: string;
    sourceSubnetId: number;
    sourcePrice?: number;
    sourceAmount?: number;

    targetAddress?: string;
    targetSubnetId: number;
    targetPrice?: number;
    targetAmount?: number;

    createdAt: string;
    updatedAt: string;
}

type SubnetPrice = {
    subnetId: number;
    name: string;
    symbol: string;

    taoPrice: number;
    usdPrice: number;
    otcTaoPrice: number;
    otcUsdPrice: number;

    timestamp: string;

    marketCapChange1Day: number;
    liquidity: number;

    enabled: boolean;
};

export async function executeValidateTransactionTask(task: TaskPayload): Promise<TaskResult> {
    const transactionId = task.params.transactionId;
    if (typeof transactionId !== 'string') {
        throw new Error('Invalid or missing transactionId parameter');
    }

    const subnetTransaction = await getTransactionDetails(transactionId);
    const subnetPrices = await getSubnetPrices([subnetTransaction.sourceSubnetId, subnetTransaction.targetSubnetId]);

    const currentSourceSubnetPrice = subnetPrices.find((price) => price.subnetId === subnetTransaction.sourceSubnetId);
    const currentTargetSubnetPrice = subnetPrices.find((price) => price.subnetId === subnetTransaction.targetSubnetId);

    if (
        !currentSourceSubnetPrice ||
        !currentTargetSubnetPrice ||
        !currentSourceSubnetPrice.taoPrice ||
        !currentTargetSubnetPrice.taoPrice ||
        !subnetTransaction.sourcePrice ||
        !subnetTransaction.targetPrice
    ) {
        throw new Error(`Missing price data for transaction ID ${transactionId}`);
    }

    const sourcePriceChangePercent =
        Math.abs((currentSourceSubnetPrice.taoPrice - subnetTransaction.sourcePrice) / subnetTransaction.sourcePrice) * 100;
    const targetPriceChangePercent =
        Math.abs((currentTargetSubnetPrice.taoPrice - subnetTransaction.targetPrice) / subnetTransaction.targetPrice) * 100;

    const acceptTransaction = sourcePriceChangePercent <= 5 && targetPriceChangePercent <= 5;

    const stdoutLines = [
        `Source subnet ID: ${subnetTransaction.sourceSubnetId}`,
        ` - Recorded price: ${subnetTransaction.sourcePrice}`,
        ` - Current price: ${currentSourceSubnetPrice.taoPrice}`,
        ` - Price change: ${sourcePriceChangePercent.toFixed(2)}%\n`,
        `Target subnet ID: ${subnetTransaction.targetSubnetId}`,
        ` - Recorded price: ${subnetTransaction.targetPrice}`,
        ` - Current price: ${currentTargetSubnetPrice.taoPrice}`,
        ` - Price change: ${targetPriceChangePercent.toFixed(2)}%\n`,
        `Transaction acceptance status: ${acceptTransaction ? 'ACCEPTED' : 'REJECTED'}`
    ];

    const stdout = stdoutLines.join('\n');

    return {
        exitCode: 0,
        artifacts: [
            {
                name: 'result.json',
                content: JSON.stringify({
                    transactionId: subnetTransaction.id,
                    acceptTransaction
                }),
                mimeType: 'application/json'
            }
        ],
        stdout: stdout,
        stderr: ''
    };
}

async function getTransactionDetails(transactionId: string): Promise<SubnetTransaction> {
    const response = await fetch(`${env.apiUrl}/transactions/${transactionId}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch transaction with ID ${transactionId}`);
    }

    const result = await response.json();

    return result.transaction as SubnetTransaction;
}

async function getSubnetPrices(subnetIds: number[]): Promise<SubnetPrice[]> {
    const response = await fetch(`${env.apiUrl}/subnets/prices?subnetIds=${subnetIds.join(',')}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch subnet prices for subnet IDs ${subnetIds.join(',')}`);
    }

    const result: { prices: SubnetPrice[] } = await response.json();

    return result.prices;
}
