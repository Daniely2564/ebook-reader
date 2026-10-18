type Draw = (rects: DOMRectList, options?: Record<string, any>) => SVGElement
export class Overlayer {
  static highlight: Draw
  static underline: Draw
  static outline: Draw
  static squiggly: Draw
  static strikethrough: Draw
  element: SVGElement
}
