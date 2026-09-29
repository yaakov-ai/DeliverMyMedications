// Email through Amazon SES and texts through Amazon Pinpoint SMS, so no third-party BAA is needed for either.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";

const ses = new SESv2Client({});
const sms = new PinpointSMSVoiceV2Client({});

export const sesMailer = from => ({
  async send(to, subject, text) {
    try {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject.slice(0, 180) }, Body: { Text: { Data: text } } } }
      }));
      return true;
    } catch (e) { console.error("ses", e.name, e.message); return false; }
  }
});

export const pinpointSms = originationNumber => ({
  async send(to, body) {
    if (!originationNumber) return false;
    try {
      await sms.send(new SendTextMessageCommand({
        DestinationPhoneNumber: to, OriginationIdentity: originationNumber,
        MessageBody: body.slice(0, 320), MessageType: "TRANSACTIONAL"
      }));
      return true;
    } catch (e) { console.error("sms", e.name, e.message); return false; }
  }
});
