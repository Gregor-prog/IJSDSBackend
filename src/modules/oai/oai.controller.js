import { handleVerb } from "./oai.service.js";

// OAI-PMH allows GET (query string) and POST (application/x-www-form-urlencoded).
export const oaiEndpoint = async (req, res, next) => {
  try {
    const args = req.method === "POST" ? { ...(req.body ?? {}) } : { ...req.query };
    const xml = await handleVerb(args);
    res.setHeader("Content-Type", "text/xml; charset=utf-8");
    return res.status(200).send(xml);
  } catch (err) {
    next(err);
  }
};
