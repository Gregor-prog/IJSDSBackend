import { exportData, exportAjol } from "./export.service.js";

export const dataExport = async (req, res, next) => {
  try {
    const {
      dataType,
      format = "csv",
      dateFrom,
      dateTo,
      include_metadata,
      include_comments,
    } = req.query;

    if (!dataType) {
      return res.status(400).json({
        success: false,
        message: "dataType is required (submissions | reviews | articles | users)",
      });
    }

    const { csv, filename, rowCount } = await exportData({
      dataType,
      format,
      dateFrom,
      dateTo,
      includeMetadata: include_metadata === "true",
      includeComments: include_comments === "true",
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Row-Count", rowCount);
    return res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
};

export const ajolExport = async (req, res, next) => {
  try {
    const { format = "xml" } = req.query;
    const { content, count, format: outFormat } = await exportAjol(format);

    if (outFormat === "xml") {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="ajol_metadata.xml"`);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="ajol_metadata.json"`);
    }

    res.setHeader("X-Article-Count", count);
    return res.status(200).send(content);
  } catch (err) {
    next(err);
  }
};
