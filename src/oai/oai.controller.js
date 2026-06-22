import { create } from "xmlbuilder2";
import prisma from "../../prisma/prisma.js";

export const oai = async (req, res) => {
  const verb = req.query.verb;
  const metadataPrefix = req.query.metadataPrefix;

  let baseUrl = "https://ijsdsbackend-429660256945.europe-southwest1.run.app";

  if (verb == "identify") {
    const xml = create({ version: "1.0", encoding: "UTF-8" })
      .ele("OAI-PMH", {
        xmlns: "http://www.openarchives.org/OAI/2.0/",
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        "xsi:schemaLocation":
          "http://www.openarchives.org/OAI/2.0/ http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd",
      })
      .ele("responseDate")
      .txt(new Date().toISOString())
      .up()
      .ele("request", { verb: "Identify" })
      .txt(baseUrl)
      .up()
      .ele("Identify")
      .ele("repositoryName")
      .txt("International Journal of Statistics and Data Science (IJSDS)")
      .up()
      .ele("baseUrl")
      .txt(baseUrl)
      .up()
      .ele("protocolVersion")
      .txt("2.0")
      .up()
      .ele("adminEmail")
      .txt("admin@ijsds.org")
      .up()
      .ele("earliestDatestamp")
      .txt("2026-01-01")
      .up()
      .ele("deletedRecord")
      .txt("no")
      .up()
      .ele("granularity")
      .txt("YYYY-MM-DD")
      .up()
      .end({ prettyPrint: true });

    return res.status(200).send(xml);
  }

  if (verb == "listRecords") {
    const articles = await prisma.article.findMany();
  }
};
