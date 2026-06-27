import config from '../config/env';

const colors = {
    info: '#2eb886',
    warning: '#ffcc00',
    error: '#ff0000'
};

export class Slack {
    static sendMessage(type: 'info' | 'warning' | 'error', message: string, data?: Record<string, any>, channel?: string): void {
        const resolvedChannel =
            channel ??
            (type === 'error'
                ? (config.slackConfig.errorChannel ?? config.slackConfig.defaultChannel)
                : (config.slackConfig.infoChannel ?? config.slackConfig.defaultChannel));

        if (!config.slackConfig.apiToken || !resolvedChannel) {
            return;
        }

        const attachments: any[] = [];

        if (data && Object.keys(data).length > 0) {
            const jsonFormatted = '```' + JSON.stringify(data, null, 4) + '```';
            attachments.push({
                fallback: 'Payload',
                pretext: '',
                title: '',
                title_link: '',
                text: jsonFormatted,
                mrkdwn_in: ['text'],
                color: colors[type],
                collapsed_by_default: false,
                is_attachment_collapsible: true,
                attachment_type: 'default'
            });
        }

        Slack.post({
            channel: resolvedChannel,
            text: message,
            unfurl_links: false,
            unfurl_media: false,
            attachments
        });
    }

    private static post(payload: Record<string, any>): void {
        fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.slackConfig.apiToken}`
            },
            body: JSON.stringify(payload)
        })
            .then(async (response) => {
                let slackResponse: Record<string, any> | null = null;
                try {
                    slackResponse = (await response.json()) as Record<string, any>;
                } catch (_) {
                    console.warn(
                        JSON.stringify({ severity: 'WARNING', message: 'Slack response was not valid JSON', payload: { status: response.status } })
                    );
                }

                if (!response.ok) {
                    console.warn(
                        JSON.stringify({
                            severity: 'WARNING',
                            message: 'Slack API request failed',
                            payload: { status: response.status, response: slackResponse ?? undefined }
                        })
                    );
                    return;
                }

                if (slackResponse && slackResponse.ok === false) {
                    console.warn(
                        JSON.stringify({ severity: 'WARNING', message: 'Slack API responded with error', payload: { error: slackResponse.error } })
                    );
                }
            })
            .catch((err) => {
                console.warn(JSON.stringify({ severity: 'WARNING', message: 'failed to send Slack notification', payload: { err: err?.message } }));
            });
    }
}
