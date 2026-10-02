import { completeJson, objectSchema, s } from './client';
import { env } from '../env';

/**
 * Classifies a single captured photo as a grocery receipt or a meal/food
 * photo, so the one floating "+" button can route to whichever pipeline
 * actually applies — see src/lib/capture.ts.
 *
 * A dedicated classification call rather than reusing meal analysis's
 * existing is_food flag: that flag only distinguishes "food or not", and a
 * receipt would legitimately confuse it (there IS text about food on a
 * receipt). This call looks for the visual shape of a receipt specifically —
 * itemized text, columns, prices, store branding — versus a plated dish.
 */

export type PhotoKind = 'receipt' | 'meal';

export type PhotoClassification = {
  kind: PhotoKind;
  confidence: number;
};

const schema = objectSchema({
  kind: { type: 'string', enum: ['receipt', 'meal'] },
  confidence: s.number,
});

const SYSTEM = `You classify a single photo as exactly one of two things:

"receipt" — a grocery or store receipt: itemized text in columns, a store
name/logo at the top, individual line items with prices, a subtotal/total,
often printed on narrow thermal paper. Photographed receipts may be angled,
creased, or partly lit by flash — that does not change the classification.

"meal" — a photo of food: a plated dish, ingredients laid out, a snack, a
drink, packaging of something about to be eaten. This includes food that is
still in its container or wrapper.

Pick "meal" whenever the photo is not clearly, primarily a receipt — a food
package with a nutrition label is still "meal", not "receipt", unless it is
specifically a checkout receipt listing prices paid.

confidence: 0-1, how sure you are.`;

export async function classifyCapturedPhoto(
  dataUrl: string
): Promise<{ classification: PhotoClassification; model: string }> {
  const { data, model } = await completeJson<PhotoClassification>({
    model: env.visionModel,
    system: SYSTEM,
    schemaName: 'photo_classification',
    schema,
    maxTokens: 200,
    temperature: 0,
    images: [{ dataUrl, detail: 'low' }],
    user: 'What is this photo?',
  });

  return { classification: data, model };
}
