import { handleVerb } from "./oai.service.js";

export const oaiEndpoint = async (req, res, next) => {
  try {
    const { verb, metadataPrefix, identifier } = req.query;
    const xml = await handleVerb({ verb, metadataPrefix, identifier });
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.status(200).send(xml);
  } catch (err) {
    next(err);
  }
};
