import { Client, Account, ID } from 'appwrite';

const endpoint = 'https://sgp.cloud.appwrite.io/v1';
const projectId = '69f221090023490a8740';

export const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId);

export const account = new Account(client);
export { ID };
