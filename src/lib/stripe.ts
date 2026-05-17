import Stripe from 'stripe';

export const stripe = (secret: string) =>
  new Stripe(secret, {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
  });
