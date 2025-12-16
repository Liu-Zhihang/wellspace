declare module '@deck.gl/mapbox' {
  export class MapboxOverlay {
    constructor(props: any)
    onAdd(map: any): HTMLElement
    onRemove(map: any): void
    setProps(props: any): void
  }
}

declare module 'deck.gl' {
  export class TripsLayer {
    constructor(props: any)
  }
  export class PathLayer {
    constructor(props: any)
  }
  export class ScatterplotLayer {
    constructor(props: any)
  }
}
