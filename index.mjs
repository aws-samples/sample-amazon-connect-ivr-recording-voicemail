// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ConnectClient, GetContactAttributesCommand, DescribeContactCommand, StartTaskContactCommand } from "@aws-sdk/client-connect";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

/**
 * Extracts contact ID from S3 object key using UUID pattern
 * @param {string} key - S3 object key
 * @returns {string|null} Contact ID if found, null otherwise
 */
const extractContactId = (key) => {
    const match = key.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
};

/**
 * Retrieves voicemail attributes for a contact
 * @param {ConnectClient} client - Amazon Connect client
 * @param {string} contactId - Contact ID
 * @returns {Object} Voicemail attributes
 */
const getVoicemailAttributes = async (client, contactId) => {
    try {
        const { Attributes } = await client.send(new GetContactAttributesCommand({
            InstanceId: process.env.INSTANCE_ID,
            InitialContactId: contactId
        }));

        console.log(JSON.stringify(Attributes));

        return {
            isVoicemail: Attributes.voicemail || false,
            destination: Attributes['voicemail-destination'] || null
        };
    } catch (error) {
        console.log('Error getting voicemail attributes:', error);
        return { isVoicemail: false, destination: null };
    }
};

/**
 * Gets contact details if destination is not available
 * @param {ConnectClient} client - Amazon Connect client
 * @param {string} contactId - Contact ID
 */
const getContactDetails = async (client, contactId) => {
    try {
        const { Contact } = await client.send(new DescribeContactCommand({
            InstanceId: process.env.INSTANCE_ID,
            ContactId: contactId
        }));
        console.log('Contact details:', JSON.stringify(Contact));
    } catch (error) {
        console.log('Error getting contact details:', error);
        throw error;
    }
};

/**
 * Creates a pre-signed URL for the S3 object
 * @param {S3Client} client - S3 client
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key
 * @returns {string|null} Pre-signed URL if successful, null otherwise
 */
const createPresignedUrl = async (client, bucket, key) => {
    try {
        return await getSignedUrl(client, 
            new GetObjectCommand({ 
                Bucket: bucket, 
                Key: decodeURIComponent(key) 
            }), 
            { expiresIn: 172800 }
        );
    } catch (error) {
        console.log('Error creating presigned URL:', error);
        return null;
    }
};

/**
 * Creates a task in Amazon Connect for the voicemail
 * @param {ConnectClient} client - Amazon Connect client
 * @param {string} contactId - Contact ID
 * @param {string} recordingUrl - Pre-signed URL for the recording
 * @returns {string|null} New contact ID if successful, null otherwise
 */
const createConnectTask = async (client, contactId, recordingUrl, destination) => {
    const taskParams = {
        RelatedContactId: contactId,
        ContactFlowId: process.env.CONTACT_FLOW_ID,
        InstanceId: process.env.INSTANCE_ID,
        Name: "New voicemail",
        References: {
            Recording: {
                Type: "URL",
                Value: recordingUrl
            }
        },
        Attributes: {
            "voicemail-destination": destination
        }
    };

    try {
        console.log('Creating task with params:', JSON.stringify(taskParams));
        const { ContactId } = await client.send(new StartTaskContactCommand(taskParams));
        return ContactId;
    } catch (error) {
        console.log('Error creating Connect task:', error);
        return null;
    }
};

/**
 * Lambda handler for processing voicemail recordings
 * @param {Object} event - Lambda event object
 * @returns {Object} Empty object
 */
export const handler = async (event) => {
    console.log('Event:', JSON.stringify(event));
    
    const connectClient = new ConnectClient();
    const s3Client = new S3Client();

    for (const record of event.Records) {
        // Only process new object creation events
        if (!['ObjectCreated:Put', 'ObjectCreated:CompleteMultipartUpload'].includes(record.eventName)) {
            continue;
        }

        console.log('Processing S3 key:', decodeURI(record.s3.object.key));
        
        // Extract and validate contact ID
        const contactId = extractContactId(record.s3.object.key);
        if (!contactId) continue;

        // Get voicemail attributes
        const { isVoicemail, destination } = await getVoicemailAttributes(connectClient, contactId);
        if (!isVoicemail) continue;

        // Get additional contact details if needed
        if (!destination) {
            try {
                await getContactDetails(connectClient, contactId);
            } catch (error) {
                continue;
            }
        }

        // Create pre-signed URL for the recording
        const presignedUrl = await createPresignedUrl(
            s3Client, 
            record.s3.bucket.name, 
            record.s3.object.key
        );
        if (!presignedUrl) continue;

        // Create Connect task for the voicemail
        await createConnectTask(connectClient, contactId, presignedUrl, destination);
    }

    return {};
};